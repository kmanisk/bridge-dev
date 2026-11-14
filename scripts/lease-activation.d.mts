export interface LeaseActivation {mode:"strict"|"standard";nonce?:string;expires?:number;}
export function readLeaseActivation(filename:string,authorityFile:string):LeaseActivation|null;
export function verifyLeaseActivation(filename:string,lease:{nonce?:unknown;expires_at?:unknown;scope?:unknown},authorityFile:string):boolean;
