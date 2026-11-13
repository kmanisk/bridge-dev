/** Native commands keep ordinary development variables, never gateway authority. */
export function childEnvironment(source:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
 return Object.fromEntries(Object.entries(source).filter(([key])=>!/(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTHORIZATION|COOKIE)/i.test(key)&&! /^(?:POLICYGATE_|BRIDGEDEV_|MCP_|ADMIN_|LOCAL_CODER_)/.test(key)));
}
