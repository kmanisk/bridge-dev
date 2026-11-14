#!/usr/bin/python3
"""On-demand host controller. Installed outside the gateway mount namespace.

No caller-supplied environment, config path, signing key or executable verifier.
Arbitrary root commands are an intentional capability of an operator YOLO lease.
"""
import ctypes, datetime, fcntl, hashlib, json, os, pwd, shutil, signal, stat, subprocess, sys, tempfile, time, uuid
from pathlib import Path

CONFIG = Path('/etc/local-coder-policygate/controller.json')
IMPLEMENTATION = Path('/usr/local/libexec/bridge-dev/host-controller.py')
VERIFIER = Path('/usr/local/libexec/bridge-dev/controller-authorize.mjs')
CLEAN = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin', 'HOME':'/root', 'LANG':'C.UTF-8'}

def check(value, message):
    if not value: raise RuntimeError(message)

def protected(path):
    p = Path(path)
    for node in [p, *p.parents]:
        st = node.lstat()
        check(st.st_uid == 0 and not st.st_mode & 0o022 and not node.is_symlink(), 'Unsafe root controller path: '+str(node))

def atomic(path, value, mode=0o600):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix='.'+path.name, dir=path.parent)
    os.fchmod(fd,mode)
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(value, handle, separators=(',',':')); handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
        os.replace(name, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(parent)
        finally: os.close(parent)
    finally:
        if os.path.exists(name): os.unlink(name)

def run(argv, timeout=30, required=True):
    result = subprocess.run([str(x) for x in argv], env=CLEAN, capture_output=True, text=True, timeout=timeout)
    if required: check(result.returncode == 0, Path(str(argv[0])).name+' failed with exit '+str(result.returncode))
    return result

def authorize(config, request):
    result = subprocess.run(['/usr/bin/node',str(VERIFIER),str(CONFIG)], input=json.dumps(request), env=CLEAN, capture_output=True, text=True, timeout=10)
    check(result.returncode == 0, 'CONTROLLER_AUTHORIZATION_REQUIRED')
    return json.loads(result.stdout)

def audit(config, event):
    # Separate root controller chain; never compete with the gateway ledger writer.
    path = Path(config['state'])/'audit.jsonl'
    with path.open('a+', encoding='utf8') as handle:
        os.chmod(path, 0o600); fcntl.flock(handle, fcntl.LOCK_EX); handle.seek(0)
        previous = '0'*64
        for line in handle:
            record = json.loads(line); digest = record.pop('hash')
            check(record['prev_hash']==previous and hashlib.sha256(json.dumps(record,separators=(',',':')).encode()).hexdigest()==digest, 'Controller audit chain invalid')
            previous = digest
        body = {'time':datetime.datetime.now(datetime.timezone.utc).isoformat(), **event, 'prev_hash':previous}
        body['hash'] = hashlib.sha256(json.dumps(body,separators=(',',':')).encode()).hexdigest()
        handle.write(json.dumps(body,separators=(',',':'))+'\n'); handle.flush(); os.fsync(handle.fileno())

def job_path(config, identifier):
    check(isinstance(identifier,str) and str(uuid.UUID(identifier))==identifier, 'Invalid job ID')
    return Path(config['state'])/'jobs'/identifier

def state(job, **values):
    current = json.loads((job/'result.json').read_text()) if (job/'result.json').exists() else {}
    current.update(values); atomic(job/'result.json', current)
    with (job/'events.jsonl').open('a') as handle:
        handle.write(json.dumps({'time':time.time(),**values},separators=(',',':'))+'\n'); handle.flush(); os.fsync(handle.fileno())
    return current

def exchange(left, right):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renameat2(-100, os.fsencode(left), -100, os.fsencode(right), 2):
        raise OSError(ctypes.get_errno(), 'Atomic release exchange failed')

def root_release(release):
    protected(release)
    # Symlinks are limited to this immutable payload, including pnpm links.
    for base, dirs, files in os.walk(release):
        for name in dirs+files:
            p = Path(base)/name; st = p.lstat()
            check(st.st_uid==0 and (p.is_symlink() or not st.st_mode & 0o022), 'Release is writable by a non-root user')
            if p.is_symlink(): check(p.resolve().is_relative_to(release.resolve()), 'Release symlink escapes payload')
    sha = (release/'DEPLOYED_COMMIT').read_text().strip()
    check(len(sha)==40 and all(c in '0123456789abcdef' for c in sha), 'Missing commit receipt')
    for name in ['dist/index.js','scripts/production-preflight.mjs','scripts/production-acceptance.mjs']:
        check((release/name).is_file(), 'Incomplete release')
    return sha

def service(config, action):
    return run(['/usr/bin/systemctl',action,config['service']], timeout=40)

def wait_health(config, timeout=35):
    import urllib.request
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen(config['health'], timeout=2) as response:
                if json.load(response).get('status')=='ok': return
        except Exception: pass
        time.sleep(.25)
    raise RuntimeError('Gateway health timeout')

def revoke_jobs(config,caller):
    atomic(config['activation_file'],{'mode':base_mode(config)},0o644)
    state_dir=Path(config['state'])
    Path(config['lease']).unlink(missing_ok=True)
    active=[]
    for job in (state_dir/'jobs').iterdir():
        result=json.loads((job/'result.json').read_text())
        if result.get('kind')=='exec' and result['status'] in ['PENDING','RUNNING']: active.append(job)
    if active:
        run(['/usr/bin/systemctl','stop',*['bridge-dev-job-'+job.name+'.service' for job in active]],timeout=40)
        for job in active: state(job,status='REVOKED',exit_code=137)
    audit(config,{'phase':'revocation','status':'revoked','jobs':[job.name for job in active],'owner':caller})
    return {'revoked':[job.name for job in active]}

def base_mode(config):
    try:
        protected(Path(config['activation_file']))
        value=json.loads(Path(config['activation_file']).read_text()).get('mode')
        if value in ['strict','standard']: return value
    except (FileNotFoundError,ValueError,RuntimeError): pass
    return 'strict'

def rollback(config, job):
    # Independent watchdog and primary worker serialize recovery on a root lock.
    with (job/'rollback.lock').open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        saved = json.loads((job/'transaction.json').read_text())
        if saved.get('verified') or saved.get('rolled_back'): return
        revoke_jobs(config,0)
        live, stage = Path(config['live']), Path(saved['release'])
        service(config,'stop')
        actual = (live/'DEPLOYED_COMMIT').read_text().strip()
        if actual == saved['new_sha']: exchange(live,stage)
        else: check(actual==saved['old_sha'], 'Unknown live version; refusing destructive rollback')
        service(config,'start'); wait_health(config)
        saved['rolled_back']=True; atomic(job/'transaction.json',saved)
        audit(config,{'phase':'rollback','job_id':job.name,'status':'restored','sha':saved['old_sha']})
        state(job,status='ROLLED_BACK',exit_code=1,rollback_release=str(stage),sha=saved['old_sha'])

def deploy(config, job, spec):
    live, release = Path(config['live']), Path(spec['release'])
    check(live!=release and release.parent==Path(config['releases']), 'Release must be a separate staged directory')
    sha = root_release(release); protected(live)
    old = (live/'DEPLOYED_COMMIT').read_text().strip()
    check(len(old)==40 and all(c in '0123456789abcdef' for c in old),'Invalid previous commit receipt')
    # Capture protected identities and hashes; audit ledger may only append.
    protected_files = {p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in config['preserve']}
    sandbox_fields=['User','Group','ProtectHome','ProtectSystem','NoNewPrivileges','ReadOnlyPaths','BindPaths','BindReadOnlyPaths','ExecStart','ExecStartPre','WorkingDirectory']
    sandbox=run(['/usr/bin/systemctl','show',config['service'],*['--property='+field for field in sandbox_fields]]).stdout
    ledger = Path(config['ledger']); info = ledger.stat(); prefix = ledger.read_bytes()
    transaction = {'release':str(release),'new_sha':sha,'old_sha':old,'verified':False}
    atomic(job/'transaction.json',transaction)
    guard = 'bridge-dev-guard-'+job.name
    run(['/usr/bin/systemd-run','--quiet','--unit='+guard,'--on-active=180s','--timer-property=AccuracySec=1s',
         '/usr/bin/python3','-I',IMPLEMENTATION,'_rollback',job.name])
    try:
        service(config,'stop'); exchange(live,release)
        state(job,status='VERIFYING',sha=sha,rollback_release=str(release))
        service(config,'start'); wait_health(config)
        result = run(['/usr/bin/node',live/'scripts/production-acceptance.mjs','accept',live,config['env_file']],timeout=65)
        acceptance = json.loads(result.stdout)
        check(acceptance.get('ok'), 'Independent MCP acceptance failed')
        check(run(['/usr/bin/systemctl','show',config['service'],*['--property='+field for field in sandbox_fields]]).stdout==sandbox, 'Gateway service sandbox changed')
        check(all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==digest for p,digest in protected_files.items()), 'Protected configuration changed')
        after = ledger.stat()
        check((info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid)==(after.st_dev,after.st_ino,after.st_mode,after.st_uid,after.st_gid), 'Ledger identity changed')
        with ledger.open('rb') as handle: check(handle.read(len(prefix))==prefix, 'Ledger prefix changed')
        check('a' in run(['/usr/bin/lsattr','-d',ledger]).stdout.split()[0], 'Audit append-only flag missing')
        transaction['verified']=True; atomic(job/'transaction.json',transaction)
        state(job,status='SUCCESS',exit_code=0,acceptance=acceptance,sha=sha,rollback_release=str(release))
    except BaseException:
        rollback(config,job); raise
    finally:
        run(['/usr/bin/systemctl','stop',guard+'.timer'],required=False)

def worker(config, identifier):
    job = job_path(config, identifier); spec = json.loads((job/'request.json').read_text())
    try:
        auth = authorize(config,spec)
        check(auth['nonce']==spec['authorization']['nonce'], 'Lease changed before job start')
        state(job,status='RUNNING',pid=os.getpid(),started_at=time.time())
        audit(config,{'phase':'execution','job_id':identifier,'status':'started','kind':spec['kind'],'request_sha256':spec['request_sha256']})
        if spec['kind']=='deploy':
            with open(Path(config['state'])/'deployment.lock','a+') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB); deploy(config,job,spec)
        else:
            deadline = min(auth['expires']/1000,time.time()+spec['timeout'])
            with (job/'stdout').open('wb') as stdout, (job/'stderr').open('wb') as stderr:
                child = subprocess.Popen(spec['argv'],cwd=spec['cwd'],env=CLEAN,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,start_new_session=True)
                revoked = False
                try:
                    while child.poll() is None:
                        if time.time()>=deadline: revoked=True; break
                        if auth['kind']=='yolo':
                            try: valid=authorize(config,{}); check(valid['nonce']==auth['nonce'], 'Lease revoked')
                            except Exception: revoked=True; break
                        # Finite supervisor exists only while a submitted command runs.
                        time.sleep(.25)
                    if revoked:
                        os.killpg(child.pid,signal.SIGKILL); child.wait(timeout=5)
                    code = child.wait(timeout=5)
                finally:
                    # Kill same-group children even when the parent exits early.
                    try: os.killpg(child.pid,signal.SIGKILL)
                    except ProcessLookupError: pass
                state(job,status='REVOKED' if revoked else 'SUCCESS' if code==0 else 'FAILED',exit_code=code)
        audit(config,{'phase':'execution','job_id':identifier,'status':json.loads((job/'result.json').read_text())['status']})
    except BaseException as error:
        current = json.loads((job/'result.json').read_text())
        if current.get('status')!='ROLLED_BACK': state(job,status='FAILED',exit_code=1,error=type(error).__name__+': '+str(error))
        audit(config,{'phase':'execution','job_id':identifier,'status':'failed','error':type(error).__name__})
        raise

def dispatch(config, action, args):
    caller = int(os.environ.get('BRIDGEDEV_CONTROLLER_CALLER_UID',os.environ.get('SUDO_UID','0')))
    check(caller==0 or caller in config['clients'], 'Caller is not an installed controller client')
    if action.startswith('_'): check(caller==0, 'Internal controller action')
    state_dir = Path(config['state']); state_dir.mkdir(mode=0o700,exist_ok=True); (state_dir/'jobs').mkdir(mode=0o700,exist_ok=True)
    protected(state_dir); protected(state_dir/'jobs')
    if action=='_worker': return worker(config,args[0])
    if action=='_rollback':
        run(['/usr/bin/systemctl','stop','bridge-dev-job-'+args[0]+'.service'],required=False)
        return rollback(config,job_path(config,args[0]))
    if action in ['activate','mode']:
        check(caller==0 and os.isatty(0) and os.isatty(1),'Activation requires an independently opened root operator terminal')
        if action=='mode':
            check(len(args)==1 and args[0] in ['strict','standard'],'Expected strict or standard mode')
            revoke_jobs(config,caller); atomic(config['activation_file'],{'mode':args[0]},0o644)
            audit(config,{'phase':'mode','status':args[0]}); return {'mode':args[0]}
        mode=base_mode(config); atomic(config['activation_file'],{'mode':mode},0o644)
        auth=authorize(config,{'operator_activation':True})
        atomic(config['activation_file'],{'mode':mode,'nonce':auth['nonce'],'expires':auth['expires']},0o644)
        audit(config,{'phase':'lease','status':'activated','expires':auth['expires']})
        return {'activated':True,'expires':auth['expires']}
    if action=='revoke':
        # Stopping work can never confer root authority. Activation remains TTY/root-only.
        return revoke_jobs(config,caller)
    if action=='status' and not args:
        jobs = [json.loads((p/'result.json').read_text()) for p in (state_dir/'jobs').iterdir() if (p/'result.json').exists()]
        try: auth=authorize(config,{})
        except Exception: auth={'kind':base_mode(config)}
        return {'authorization':auth,'jobs':jobs}
    if action in ['status','logs','rollback','cleanup']:
        job = job_path(config,args[0]); result = json.loads((job/'result.json').read_text())
        check(caller==0 or result['owner']==caller, 'Job belongs to a different controller client')
        if action=='status':
            if result['status'] in ['PENDING','RUNNING','VERIFYING']:
                active=run(['/usr/bin/systemctl','is-active','bridge-dev-job-'+job.name+'.service'],required=False).stdout.strip()
                if active not in ['active','activating']:
                    if (job/'transaction.json').exists(): rollback(config,job)
                    else: state(job,status='INTERRUPTED',exit_code=1)
            return json.loads((job/'result.json').read_text())
        if action=='logs' and result['kind']=='deploy':
            return {'events':(job/'events.jsonl').read_text()[-1048576:]}
        if action=='cleanup':
            check(result['status'] not in ['PENDING','RUNNING','VERIFYING'],'Job still active')
            for name in ['stdout','stderr']: (job/name).unlink(missing_ok=True)
            audit(config,{'phase':'cleanup','job_id':job.name,'status':'outputs_removed','owner':caller})
            return {'job_id':job.name,'cleaned':True}
        authorize(config,json.loads((job/'request.json').read_text()) if action=='logs' else {})
        if action=='logs': return {key:(job/key).read_bytes()[-1048576:].decode('utf8',errors='replace') if (job/key).exists() else '' for key in ['stdout','stderr','events.jsonl']}
        if action=='rollback':
            saved=json.loads((job/'transaction.json').read_text()); saved['verified']=False; atomic(job/'transaction.json',saved); rollback(config,job); return json.loads((job/'result.json').read_text())
    check(action=='submit','Unsupported controller action')
    raw = sys.stdin.buffer.read(262145); check(len(raw)<=262144,'Controller request too large')
    request=json.loads(raw); check(isinstance(request,dict),'Expected request object')
    check(set(request).issubset({'kind','argv','cwd','timeout','request_id','approval_id','release'}),'Unknown controller request field')
    check(request.get('kind') in ['exec','deploy'],'Unsupported job kind')
    if request['kind']=='exec':
        check(isinstance(request.get('argv'),list) and 0<len(request['argv'])<=256 and all(isinstance(x,str) and '\0' not in x for x in request['argv']), 'Invalid argument array')
        check(os.path.isabs(request['argv'][0]),'Executable must be absolute')
        check(isinstance(request.get('cwd'),str) and os.path.isabs(request['cwd']), 'Absolute cwd required')
        check(type(request.get('timeout',120)) is int and 1<=request.get('timeout',120)<=7200,'Invalid timeout')
        request.setdefault('timeout',120)
    with (state_dir/'submission.lock').open('a+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        # Idempotency key is scoped to caller and exact body, never command text alone.
        key=request.get('request_id'); check(isinstance(key,str) and str(uuid.UUID(key))==key,'Persistent request_id UUID required')
        request_hash=hashlib.sha256(raw).hexdigest()
        for existing in (state_dir/'jobs').iterdir():
            result=json.loads((existing/'result.json').read_text())
            if result.get('request_id')==key and result['owner']==caller:
                check(result['request_sha256']==request_hash,'Request ID reused with different arguments'); return result
            if request['kind']=='deploy' and result.get('kind')=='deploy' and result['status'] in ['PENDING','RUNNING','VERIFYING']:
                raise RuntimeError('Existing deployment job: '+result['job_id']+'; inspect before retry')
        auth=authorize(config,request)
        if request['kind']=='deploy':
            check(auth['kind']=='yolo','Deployment requires an independently authorized YOLO lease')
            root_release(Path(request['release']))
        if auth['kind']=='approval':
            spent=state_dir/('spent-'+auth['nonce']); fd=os.open(spent,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.close(fd)
        identifier=str(uuid.uuid4()); job=job_path(config,identifier); job.mkdir(mode=0o700)
        request.update(authorization=auth,request_sha256=request_hash); atomic(job/'request.json',request)
        result=state(job,job_id=identifier,request_id=key,request_sha256=request_hash,owner=caller,kind=request['kind'],status='PENDING',exit_code=None,log_path=str(job))
        audit(config,{'phase':'authorization','job_id':identifier,'status':'granted','kind':auth['kind'],'owner':caller,'request_sha256':request_hash})
        try:
            runtime = 300 if request['kind']=='deploy' else max(1,min(request['timeout'],int((auth['expires']/1000-time.time()))))
            run(['/usr/bin/systemd-run','--quiet','--collect','--unit=bridge-dev-job-'+identifier,'--property=Type=exec','--property=KillMode=control-group',
                 '--property=TimeoutStopSec=5s','--property=RuntimeMaxSec='+str(runtime)+'s', '/usr/bin/python3','-I',IMPLEMENTATION,'_worker',identifier])
        except Exception:
            state(job,status='FAILED',exit_code=1); raise
        return result

def main():
    check(os.geteuid()==0,'Controller requires actual root UID via installed sudo entry')
    protected(CONFIG); protected(IMPLEMENTATION); protected(VERIFIER)
    config=json.loads(CONFIG.read_text())
    for key in ['public_key','lease','activation_file','approvals','policy','mode_file','state','service','live','releases','env_file','health','preserve','ledger','clients']: check(key in config,'Incomplete operator controller configuration')
    protected(Path(config['activation_file']).parent)
    result=dispatch(config,sys.argv[1],sys.argv[2:])
    if result is not None: print(json.dumps(result,separators=(',',':')))

if __name__=='__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'ok':False,'error':str(error)}),file=sys.stderr); sys.exit(1)
