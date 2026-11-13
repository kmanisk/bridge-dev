#!/usr/bin/python3 -I
"""Legacy shell API adapter; execution and authority live in the host controller."""
import json, os, subprocess, sys, time, uuid

def legacy_request(arguments,cwd):
    if not arguments: raise RuntimeError('No command specified')
    return {'kind':'exec','request_id':str(uuid.uuid4()),'argv':['/bin/bash','-c',' '.join(arguments)],'cwd':cwd,'timeout':120}

def execute_legacy(arguments,cwd,call):
    result=call('submit',[],legacy_request(arguments,cwd)); identifier=result['job_id']; deadline=time.monotonic()+130
    while result['status'] in ['PENDING','RUNNING']:
        if time.monotonic()>deadline: raise RuntimeError('Controller timeout; inspect existing job '+identifier)
        time.sleep(.25); result=call('status',[identifier])
    output=call('logs',[identifier]); code=result.get('exit_code')
    return {**output,'exit_code':code if isinstance(code,int) else 1,'job_id':identifier}

def controller(action,arguments=None,request=None):
    result=subprocess.run(['/usr/local/bin/bridge-dev-controller',action,*(arguments or [])],
        input=json.dumps(request) if request is not None else None,capture_output=True,text=True,timeout=45,
        env={'PATH':'/usr/bin:/bin','SUDO_UID':os.environ.get('SUDO_UID','0')})
    if result.returncode: raise RuntimeError('CONTROLLER_AUTHORIZATION_REQUIRED: legacy broker delegates to the revoked/expired-lease-aware controller')
    return json.loads(result.stdout)

if __name__=='__main__':
    try:
        if os.geteuid()!=0: raise RuntimeError('Legacy broker requires its installed sudo entry')
        result=execute_legacy(sys.argv[1:],os.getcwd(),controller)
        sys.stdout.write(result.get('stdout','')); sys.stderr.write(result.get('stderr','')); sys.exit(result['exit_code'])
    except Exception as error: print(str(error),file=sys.stderr); sys.exit(1)
