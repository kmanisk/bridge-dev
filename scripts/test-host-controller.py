import importlib.util, io, json, multiprocessing, os, subprocess, sys, tempfile, time, types, uuid
from pathlib import Path
from unittest.mock import patch

# Regression: a root install launched with umask 077 must not leave the
# gateway's activation directory at inaccessible mode 0700.
install_spec=importlib.util.spec_from_file_location('host_installer','scripts/install-host-controller.py')
installer=importlib.util.module_from_spec(install_spec); install_spec.loader.exec_module(installer)
with tempfile.TemporaryDirectory(prefix='bridge-mode-perms-') as temp:
    destination=Path(temp)/'operator-activation'
    previous=os.umask(0o077)
    try: installer.ensure_gateway_readable_activation_dir(destination, owner_uid=os.getuid())
    finally: os.umask(previous)
    assert (destination.stat().st_mode & 0o777)==0o755
    destination.chmod(0o700)
    installer.ensure_gateway_readable_activation_dir(destination, owner_uid=os.getuid())
    assert (destination.stat().st_mode & 0o777)==0o755
    destination.chmod(0o777)
    try: installer.ensure_gateway_readable_activation_dir(destination, owner_uid=os.getuid())
    except RuntimeError: pass
    else: raise AssertionError('Unsafe writable activation directory was accepted')
    destination.chmod(0o755)

spec=importlib.util.spec_from_file_location('host_controller','scripts/host-controller.py')
c=importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
root=Path(sys.argv[1]); jobs=root/'jobs'; jobs.mkdir()
entry_spec=importlib.util.spec_from_file_location('entry','scripts/controller-entry.py'); entry=importlib.util.module_from_spec(entry_spec); entry_spec.loader.exec_module(entry)
command=entry.request_command(947,['status','fixture'])
assert '--setenv=BRIDGEDEV_CONTROLLER_CALLER_UID=947' in command
assert command[command.index('--')+1:]==['/usr/bin/python3','-I',entry.CONTROLLER,'status','fixture']
assert '--pipe' in command and '--wait' in command and '--collect' in command
assert entry.request_caller('0','private','host',947)==947
assert entry.request_caller('1000','private','host',947)==947
assert entry.request_caller('0','host','host',947)==0
for internal in ['_worker','_rollback','activate','mode']:
    try: entry.request_command(0,[internal,str(uuid.uuid4())])
    except RuntimeError: pass
    else: raise AssertionError('Internal root action exposed through sudo entry')
legacy_spec=importlib.util.spec_from_file_location('legacy','scripts/legacy-escalation.py'); legacy=importlib.util.module_from_spec(legacy_spec); legacy_spec.loader.exec_module(legacy)
assert legacy.legacy_request(['id','-u'],'/fixture')['argv']==['/bin/bash','-c','id -u']
def refused(*args): raise RuntimeError('CONTROLLER_AUTHORIZATION_REQUIRED')
try: legacy.execute_legacy(['id'],'/fixture',refused)
except RuntimeError: pass
else: raise AssertionError('Legacy alias bypassed controller authorization')
def alias_fixture(action,args,request=None):
    if action=='submit': return {'job_id':'fixture','status':'SUCCESS','exit_code':0}
    assert action=='logs'; return {'stdout':'UNPRIVILEGED_ALIAS_FIXTURE','stderr':''}
assert legacy.execute_legacy(['id'],'/fixture',alias_fixture)['stdout']=='UNPRIVILEGED_ALIAS_FIXTURE'
config={'state':str(root),'activation_file':str(root/'active-lease.json'),'lease':str(root/'lease.json'),'clients':[os.getuid()],'service':'fixture.service','live':str(root/'live'),'releases':str(root/'releases'),'preserve':[], 'ledger':str(root/'ledger'),'env_file':str(root/'fixture.env')}
auth={'kind':'yolo','nonce':'fixture','expires':int(time.time()*1000)+30_000}

def job(kind='exec',**extra):
    identifier=str(uuid.uuid4()); path=jobs/identifier; path.mkdir()
    request={'kind':kind,'argv':['/bin/sh','-c','printf fixture; printf error >&2'],'cwd':str(root),'timeout':5,'authorization':auth,'request_sha256':'fixture',**extra}
    c.atomic(path/'request.json',request); c.state(path,job_id=identifier,owner=os.getuid(),kind=kind,status='PENDING',exit_code=None)
    return path

with patch.object(c,'authorize',return_value=auth),patch.object(c,'protected'),patch.object(c,'audit'):
    path=job(); c.worker(config,path.name)
    assert json.loads((path/'result.json').read_text())['exit_code']==0
    assert (path/'stdout').read_text()=='fixture'
    # Non-expiring authorization does not remove the per-command deadline.
    forever={'kind':'yolo','nonce':'fixture','expires':None,'lifetime':'until_off'}
    path=job()
    with patch.object(c,'authorize',return_value=forever): c.worker(config,path.name)
    assert json.loads((path/'result.json').read_text())['exit_code']==0
    # Multi-command shell operations run verbatim, as the unprivileged fixture UID.
    path=job(argv=['/bin/sh','-c','id -u; mkdir -p fixture-dir; printf data > fixture-dir/file; cat fixture-dir/file; rm -r fixture-dir'])
    c.worker(config,path.name); assert (path/'stdout').read_text().strip()==str(os.getuid())+'\ndata'
    assert not (root/'fixture-dir').exists()
    path=job(argv=['/bin/sh','-c','sleep 30 & wait'])
    with patch.object(c,'authorize',side_effect=[auth,RuntimeError('revoked')]): c.worker(config,path.name)
    assert json.loads((path/'result.json').read_text())['status']=='REVOKED'
    path=job(argv=['/bin/sh','-c','sleep 30'],timeout=1); c.worker(config,path.name)
    assert json.loads((path/'result.json').read_text())['status']=='REVOKED'
    # Restart recovery: a vanished transient job is reported, never duplicated.
    path=job()
    with patch.object(c,'run',return_value=subprocess.CompletedProcess([],3,'inactive\n','')):
        assert c.dispatch(config,'status',[path.name])['status']=='INTERRUPTED'

    # Failure and timeout rollback execute the actual transaction functions on copies.
    releases=Path(config['releases']); releases.mkdir(); live=Path(config['live']); live.mkdir()
    (live/'DEPLOYED_COMMIT').write_text('a'*40); Path(config['ledger']).write_bytes(b'fixture ledger\n')
    def fake_run(argv,**kwargs):
        if 'production-acceptance.mjs' in str(argv): return subprocess.CompletedProcess(argv,0,'{"ok":true}','')
        if '/usr/bin/lsattr' in argv: return subprocess.CompletedProcess(argv,0,'-----a----- fixture','')
        return subprocess.CompletedProcess(argv,0,'','')
    for fail in [None,'acceptance','timeout']:
        release=releases/str(uuid.uuid4()); release.mkdir(); (release/'DEPLOYED_COMMIT').write_text('b'*40)
        path=job(kind='deploy',release=str(release))
        def run(argv,**kwargs):
            if 'production-acceptance.mjs' in str(argv) and fail:
                if fail=='timeout': raise subprocess.TimeoutExpired(argv,1)
                raise RuntimeError('Fixture acceptance failed')
            return fake_run(argv,**kwargs)
        with patch.object(c,'root_release',return_value='b'*40),patch.object(c,'service'),patch.object(c,'wait_health'),patch.object(c,'run',side_effect=run):
            if fail:
                try: c.deploy(config,path,json.loads((path/'request.json').read_text()))
                except (RuntimeError,subprocess.TimeoutExpired): pass
                else: raise AssertionError('Expected failure')
                assert (live/'DEPLOYED_COMMIT').read_text()=='a'*40
                assert json.loads((path/'result.json').read_text())['status']=='ROLLED_BACK'
            else:
                c.deploy(config,path,json.loads((path/'request.json').read_text()))
                assert (live/'DEPLOYED_COMMIT').read_text()=='b'*40
                saved=json.loads((path/'transaction.json').read_text()); saved['verified']=False; c.atomic(path/'transaction.json',saved)
                c.rollback(config,path); assert (live/'DEPLOYED_COMMIT').read_text()=='a'*40
    assert Path(config['ledger']).read_bytes()==b'fixture ledger\n'
    request={'kind':'exec','request_id':str(uuid.uuid4()),'argv':['/bin/sh','-c','printf harmless'],'cwd':str(root),'timeout':5}
    def submit(value):
        with patch.object(c.sys,'stdin',types.SimpleNamespace(buffer=io.BytesIO(json.dumps(value).encode()))),patch.object(c,'run',side_effect=fake_run):
            return c.dispatch(config,'submit',[])
    with patch.object(c.os,'isatty',return_value=False):
        try: c.dispatch(config,'activate',[])
        except RuntimeError: pass
        else: raise AssertionError('Noninteractive activation accepted')
    try: submit({**request,'operator_activation':True})
    except RuntimeError: pass
    else: raise AssertionError('Caller-controlled activation accepted')
    original=submit(request); repeated=submit(request); assert original['job_id']==repeated['job_id']
    try: submit({**request,'argv':['/bin/sh','-c','different']})
    except RuntimeError: pass
    else: raise AssertionError('Idempotency key permitted different command')
    # Real cross-process flock serializes duplicate submissions; no real systemd calls.
    queue=multiprocessing.get_context('fork').Queue()
    def concurrent():
        try: queue.put(submit(request)['job_id'])
        except Exception as error: queue.put(str(error))
    children=[multiprocessing.get_context('fork').Process(target=concurrent) for _ in range(4)]
    for child in children: child.start()
    results=[queue.get(timeout=10) for _ in children]
    for child in children: child.join(10); assert child.exitcode==0
    assert set(results)=={original['job_id']}

c.audit(config,{'phase':'fixture','status':'granted'}); c.audit(config,{'phase':'fixture','status':'revoked'})
audit=root/'audit.jsonl'; content=audit.read_text(); audit.write_text(content.replace('granted','tampered'))
try: c.audit(config,{'phase':'fixture','status':'denied'})
except RuntimeError: pass
else: raise AssertionError('Controller audit tampering accepted')

print('Controller fixture backend: arbitrary argv, multi-command execution, expiry/revocation, children cleanup, restart recovery, deployment success, explicit rollback, failed acceptance and timeout rollback PASS')
