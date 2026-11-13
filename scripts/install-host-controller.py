#!/usr/bin/python3
"""Independent operator bootstrap. Does not start/restart the gateway or issue a lease."""
import argparse, datetime, hashlib, json, os, pwd, re, shutil, subprocess, tempfile
from pathlib import Path

FILES=['host-controller.py','controller-entry.py','controller-authorize.mjs','policygate-operator.mjs','legacy-escalation.py']
def manifest(source):
    return {name:hashlib.sha256((Path(source)/'scripts'/name).read_bytes()).hexdigest() for name in FILES}

def safe_parents(path):
    for node in [path,*path.parents]:
        if node.exists():
            info=node.lstat()
            if node.is_symlink() or info.st_uid!=0 or info.st_mode&0o022: raise RuntimeError('Unsafe installed controller path: '+str(node))

def write_atomic(path,payload,mode):
    safe_parents(path)
    fd,name=tempfile.mkstemp(prefix='.'+path.name,dir=path.parent)
    try:
        os.fchmod(fd,mode); os.fchown(fd,0,0)
        with os.fdopen(fd,'wb') as handle: handle.write(payload); handle.flush(); os.fsync(handle.fileno())
        os.replace(name,path)
    finally:
        if os.path.exists(name): os.unlink(name)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True); parser.add_argument('--manifest-sha256'); parser.add_argument('--print-manifest',action='store_true')
    parser.add_argument('--operator-user',default=os.environ.get('SUDO_USER')); parser.add_argument('--gateway-user',default='localcoder')
    args=parser.parse_args(); source=Path(args.source).resolve(); expected=manifest(source)
    digest=hashlib.sha256(json.dumps(expected,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    if args.print_manifest: print(json.dumps({'sha256':digest,'files':expected})); return
    if os.geteuid()!=0 or not os.isatty(0): raise RuntimeError('Bootstrap requires an independent root operator terminal')
    if digest!=args.manifest_sha256: raise RuntimeError('Bootstrap manifest hash differs from reviewed source')
    for process in Path('/proc').iterdir():
        if not process.name.isdigit(): continue
        try: argv=(process/'cmdline').read_bytes().split(b'\0')
        except (FileNotFoundError,PermissionError,ProcessLookupError): continue
        if b'/usr/local/bin/local-coder-escalation-broker' in argv: raise RuntimeError('Legacy escalation is running; wait for PID '+process.name+' before bootstrap')
    for user in [args.operator_user,args.gateway_user]:
        if not user or not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_-]*\$?',user) or pwd.getpwnam(user).pw_uid==0: raise RuntimeError('Explicit non-root operator and gateway users required')
    config=Path('/etc/local-coder-policygate/controller.json')
    proposed={'public_key':'/etc/local-coder-policygate/operator-public.pem','lease':'/var/lib/local-coder-policygate/yolo-lease.json',
              'approvals':'/var/lib/local-coder-policygate/approvals','state':'/var/lib/bridge-dev-controller',
              'policy':'/etc/local-coder-policygate/policy.json','mode_file':'/var/lib/local-coder-policygate/mode.json',
              'service':'chatgpt-local-coder-policygate.service','live':'/opt/bridge-dev','releases':'/opt/bridge-dev-releases',
              'env_file':'/etc/local-coder-policygate/service.env','health':'http://127.0.0.1:3000/health',
              'ledger':'/var/log/local-coder-policygate/audit.jsonl',
              'preserve':['/etc/local-coder-policygate/service.env','/etc/local-coder-policygate/policy.json','/etc/local-coder-policygate/operator-public.pem',
                          '/etc/local-coder-policygate/operator-private.pem','/etc/local-coder-policygate/audit-anchor.json','/etc/local-coder-policygate/mcp-upstream.json'],
              'gateway_uid':pwd.getpwnam(args.gateway_user).pw_uid,
              'clients':[pwd.getpwnam(args.operator_user).pw_uid,pwd.getpwnam(args.gateway_user).pw_uid]}
    # Never rewrite existing operator configuration during upgrades.
    if config.exists():
        if json.loads(config.read_text())!=proposed: raise RuntimeError('Existing controller configuration differs; operator review required')
    safe_parents(config)
    state=Path(proposed['state']); state.mkdir(mode=0o700,exist_ok=True)
    safe_parents(state)
    active=state/'active-lease.json'
    if active.exists() and json.loads(active.read_text()).get('expires',0)>datetime.datetime.now().timestamp()*1000: raise RuntimeError('Deactivate the existing controller lease before updating its implementation')
    for result in (state/'jobs').glob('*/result.json'):
        if json.loads(result.read_text()).get('status') in ['PENDING','RUNNING','VERIFYING']: raise RuntimeError('Controller job is still active: '+result.parent.name)
    base=Path('/usr/local/libexec/bridge-dev'); safe_parents(base); base.mkdir(mode=0o755,parents=True,exist_ok=True)
    wrapper=Path('/usr/local/bin/bridge-dev-controller')
    safe_parents(wrapper)
    # Root backup covers only controller files, never credentials or the audit ledger.
    backup=state/'bootstrap-backups'/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'); backup.mkdir(mode=0o700,parents=True)
    legacy=Path('/usr/local/bin/local-coder-escalation-broker')
    targets=[base/name for name in FILES]+[wrapper,config,legacy,Path('/etc/sudoers.d/bridge-dev-controller')]
    for index,target in enumerate(targets):
        safe_parents(target)
        if target.exists():
            copy=backup/(str(index)+'-'+target.name); shutil.copy2(target,copy)
            if hashlib.sha256(copy.read_bytes()).digest()!=hashlib.sha256(target.read_bytes()).digest(): raise RuntimeError('Controller backup verification failed')
    if Path('/etc/snapper/configs/root').exists(): subprocess.run(['/usr/bin/snapper','-c','root','create','--type','pre','--print-number','--description','pre BridgeDev host controller bootstrap'],check=True)
    for name in FILES:
        payload=(source/'scripts'/name).read_bytes()
        if hashlib.sha256(payload).hexdigest()!=expected[name]: raise RuntimeError('Source changed during bootstrap')
        write_atomic(base/name,payload,0o644)
    if not config.exists(): write_atomic(config,(json.dumps(proposed,indent=2)+'\n').encode(),0o644)
    write_atomic(wrapper,(base/'controller-entry.py').read_bytes(),0o755)
    # Retain its sudoers path/API, without a separate replayable authority path.
    write_atomic(legacy,(base/'legacy-escalation.py').read_bytes(),0o755)
    # Sudo authenticates who invoked the fixed helper. It never grants arbitrary sudo itself.
    sudoers=''.join(user+' ALL=(root) NOPASSWD: NOSETENV: /usr/local/bin/bridge-dev-controller *\n' for user in [args.operator_user,args.gateway_user])
    fd,temporary=tempfile.mkstemp(prefix='bridge-controller-',dir='/etc/sudoers.d'); os.write(fd,sudoers.encode()); os.close(fd); os.chmod(temporary,0o440)
    try:
        subprocess.run(['/usr/bin/visudo','-cf',temporary],check=True)
        os.replace(temporary,'/etc/sudoers.d/bridge-dev-controller')
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    print('Installed inactive on-demand host controller. Gateway, credentials and audit ledger unchanged.')
    print('Verified controller backup: '+str(backup))
    print('Activate once from this independent operator terminal:')
    print('sudo /usr/bin/node /usr/local/libexec/bridge-dev/policygate-operator.mjs yolo --duration 60')

if __name__=='__main__': main()
