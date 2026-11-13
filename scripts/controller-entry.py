#!/usr/bin/python3 -I
"""Root entry shim: forward into host systemd, preserving the original sudo UID."""
import json, os, sys, uuid

CONTROLLER='/usr/local/libexec/bridge-dev/host-controller.py'
CLEAN={'PATH':'/usr/bin:/bin','HOME':'/root','LANG':'C.UTF-8'}

def request_caller(sudo_uid,mount_namespace,host_namespace,gateway_uid):
    # A root process inside the gateway namespace is still a gateway client.
    return gateway_uid if mount_namespace!=host_namespace else int(sudo_uid)

def request_command(caller, arguments):
    if not arguments or arguments[0] not in ['status','logs','submit','rollback','cleanup','revoke']:
        raise RuntimeError('Internal worker/watchdog actions are not exposed through sudo')
    return ['/usr/bin/systemd-run','--quiet','--wait','--pipe','--collect',
            '--unit=bridge-dev-request-'+str(uuid.uuid4()),'--property=Type=exec',
            '--property=RuntimeMaxSec=120s','--property=TimeoutStopSec=5s',
            '--setenv=BRIDGEDEV_CONTROLLER_CALLER_UID='+str(caller),
            '--','/usr/bin/python3','-I',CONTROLLER,*arguments]

def main():
    if os.geteuid()!=0: raise RuntimeError('Use the installed sudo controller entry')
    with open('/etc/local-coder-policygate/controller.json') as handle: config=json.load(handle)
    caller=request_caller(os.environ.get('SUDO_UID','0'),os.readlink('/proc/self/ns/mnt'),os.readlink('/proc/1/ns/mnt'),config['gateway_uid'])
    if len(sys.argv)<2: raise RuntimeError('Controller action required')
    if sys.argv[1]=='activate':
        if caller!=0 or not os.isatty(0) or not os.isatty(1): raise RuntimeError('Independent root operator TTY required')
        if os.readlink('/proc/self/ns/mnt')!=os.readlink('/proc/1/ns/mnt'): raise RuntimeError('Activate from the host namespace')
        os.execve('/usr/bin/python3',['/usr/bin/python3','-I',CONTROLLER,*sys.argv[1:]],CLEAN)
    argv=request_command(caller,sys.argv[1:]); os.execve(argv[0],argv,CLEAN)

if __name__=='__main__': main()
