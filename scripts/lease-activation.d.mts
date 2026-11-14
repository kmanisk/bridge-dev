export interface LeaseActivation {mode:"strict"|"standard";nonce?:string;expires?:number|null;lifetime?:"until_off";}
export function isPermanentLease(lease:unknown):boolean;
export function isActiveLease(lease:unknown,now?:number):boolean;
export function readLeaseActivation(filename:string,authorityFile:string):LeaseActivation|null;
export function verifyLeaseActivation(filename:string,lease:{nonce?:unknown;expires_at?:unknown;scope?:unknown;lifetime?:unknown},authorityFile:string):boolean;
