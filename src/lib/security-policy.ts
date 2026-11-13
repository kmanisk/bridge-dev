import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";

export type OperationClass = "read_only" | "routine_edit" | "privileged_edit" | "high_risk";

export type SecurityMode = "open" | "managed" | "strict";

export interface OperationRequest {
  type: "file_read" | "file_write" | "file_delete" | "command" | "repl_eval";
  target?: string;
  command?: string;
  contentHash?: string;
  commandHash?: string;
  details?: Record<string, unknown>;
}

export interface AuthorizationRecord {
  token: string;
  id: string;
  operationClass: OperationClass;
  targetPath?: string;
  commandHash?: string;
  contentHash?: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  usedCount: number;
  origin: "user_approval" | "scoped_grant";
}

export interface SecurityCheckResult {
  allowed: boolean;
  operationClass: OperationClass;
  reason?: string;
  error?: string;
  requiredClass?: OperationClass;
  operationHash?: string;
}

function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

const HIGH_RISK_PATH_PATTERNS = [
  /^\/etc\/sudoers(\.d\/.*)?$/,
  /^\/etc\/(shadow|gshadow|security\/.*|pam\.d\/.*)$/,
  /^\/boot\/(efi|grub|loader)(\/.*)?$/,
  /^\/dev(\/.*)?$/,
  /^\/sys\/(firmware|kernel\/security)(\/.*)?$/,
  /^\/proc\/sys\/(kernel|vm|fs)(\/.*)?$/,
];

const PRIVILEGED_PREFIXES = [
  "/etc", "/boot", "/usr", "/var", "/opt", "/root", "/proc", "/sys"
];

const HIGH_RISK_COMMAND_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bchezmoi\b[^\n]*\bapply\b/, reason: "Applying chezmoi sources changes live configuration; requires separate explicit approval" },
  { pattern: /\b(sudo\s+.*)?\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\/|\/\*|~|\$HOME|\.\.|\/etc|\/boot|\/usr|\/var|\/opt|\/root)(\s|$)/, reason: "Catastrophic recursive deletion on system path" },
  { pattern: /\bsudo\s+.*rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+/, reason: "Privileged recursive deletion" },
  { pattern: /\b(mkfs|wipefs|parted|gdisk|fdisk)\b/, reason: "Direct disk formatting or partition modification" },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: "Raw block device write via dd" },
  { pattern: /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+777\s+\//, reason: "Root filesystem permission destruction" },
  { pattern: /\b(visudo\b|(cp|mv|tee|rm|chmod|chown).*\/etc\/sudoers)/, reason: "Tampering with system sudoers" },
  { pattern: /\befibootmgr\s+.*(-B|-c)/, reason: "EFI boot entry deletion or modification" },
];

const PRIVILEGED_COMMAND_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(sudo|su|pkexec|doas)\b/, reason: "Privilege escalation via sudo/su" },
  { pattern: /\bpacman\s+-[SRU]/, reason: "Direct system package installation/removal" },
  { pattern: /\byay\s+-[SRU]/, reason: "AUR/system package management" },
  { pattern: /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask)\b/, reason: "Service management" },
];

const READ_ONLY_COMMANDS = new Set([
  "ls", "dir", "cat", "head", "tail", "more", "less", "grep", "rg", "find",
  "pwd", "echo", "printf", "uptime", "whoami", "id", "uname", "hostname",
  "df", "du", "free", "ps", "top", "btop", "stat", "file", "which", "whereis",
  "git status", "git diff", "git log", "git show", "git branch",
  "systemctl status", "systemctl is-active", "systemctl is-enabled", "systemctl --failed",
  "journalctl", "dmesg", "ss", "netstat", "ip addr", "ip route",
]);

export class SecurityPolicy {
  private mode: SecurityMode;
  private authorizations: Map<string, AuthorizationRecord> = new Map();
  private homedir: string;
  private authSecret: Buffer;

  constructor(mode?: SecurityMode, secret?: string | Buffer) {
    const rawMode = (mode || process.env.SECURITY_MODE || "managed").trim().toLowerCase();
    this.mode = rawMode === "strict" ? "strict" : rawMode === "open" ? "open" : "managed";
    this.homedir = path.resolve(os.homedir());
    this.authSecret = secret
      ? (Buffer.isBuffer(secret) ? secret : Buffer.from(secret))
      : process.env.LOCAL_CODER_AUTH_SECRET
      ? Buffer.from(process.env.LOCAL_CODER_AUTH_SECRET)
      : crypto.randomBytes(32);
  }

  getMode(): SecurityMode {
    return this.mode;
  }

  setMode(mode: SecurityMode): void {
    this.mode = mode;
  }

  classifyPath(filePath: string): OperationClass {
    const resolved = path.resolve(filePath);

    // 1. High risk paths (exact match or prefix)
    for (const pattern of HIGH_RISK_PATH_PATTERNS) {
      if (pattern.test(resolved)) {
        return "high_risk";
      }
    }

    // 2. Privileged paths outside user home/tmp
    for (const prefix of PRIVILEGED_PREFIXES) {
      if (resolved === prefix || resolved.startsWith(prefix + path.sep)) {
        return "privileged_edit";
      }
    }

    // 3. Inspect stat if file exists and is owned by root
    try {
      const stat = fs.lstatSync(resolved);
      if (stat.uid === 0 && resolved.startsWith(this.homedir)) {
        return "privileged_edit";
      }
    } catch {}

    return "routine_edit";
  }

  classifyCommand(commandStr: string): { operationClass: OperationClass; reason?: string } {
    const trimmed = commandStr.trim();

    // 1. High risk commands
    for (const { pattern, reason } of HIGH_RISK_COMMAND_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { operationClass: "high_risk", reason };
      }
    }

    // 2. Privileged commands
    for (const { pattern, reason } of PRIVILEGED_COMMAND_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { operationClass: "privileged_edit", reason };
      }
    }

    // 3. Read only check
    const baseCommand = trimmed.split(/[\s|;&]+/)[0];
    if (READ_ONLY_COMMANDS.has(baseCommand) || READ_ONLY_COMMANDS.has(trimmed)) {
      if (!/[>|;&]/.test(trimmed) || trimmed.startsWith("git ") || trimmed.startsWith("systemctl status")) {
        return { operationClass: "read_only" };
      }
    }

    return { operationClass: "routine_edit" };
  }

  private signPayload(id: string, opClass: string, targetPath?: string, cmdHash?: string, contentHash?: string, exp?: number): string {
    const payload = `${id}:${opClass}:${targetPath || ""}:${cmdHash || ""}:${contentHash || ""}:${exp || 0}`;
    return crypto.createHmac("sha256", this.authSecret).update(payload).digest("hex").slice(0, 32);
  }

  createAuthorization(opts: {
    operationClass: OperationClass;
    targetPath?: string;
    command?: string;
    content?: string | Buffer;
    ttlMs?: number;
    maxUses?: number;
    origin?: "user_approval" | "scoped_grant";
  }): string {
    const id = crypto.randomBytes(16).toString("hex");
    const now = Date.now();
    const ttl = opts.ttlMs ?? 3 * 60 * 1000; // 3 minutes default
    const expiresAt = now + ttl;
    const resolvedTarget = opts.targetPath ? path.resolve(opts.targetPath) : undefined;
    const cmdHash = opts.command ? sha256(opts.command.trim()) : undefined;
    const contentHash = opts.content ? sha256(opts.content) : undefined;

    const signature = this.signPayload(id, opts.operationClass, resolvedTarget, cmdHash, contentHash, expiresAt);
    const token = `auth_${id}.${signature}`;

    const record: AuthorizationRecord = {
      token,
      id,
      operationClass: opts.operationClass,
      targetPath: resolvedTarget,
      commandHash: cmdHash,
      contentHash,
      createdAt: now,
      expiresAt,
      maxUses: opts.maxUses ?? 1,
      usedCount: 0,
      origin: opts.origin ?? "scoped_grant",
    };
    this.authorizations.set(token, record);
    return token;
  }

  validateAuthorization(token: string | undefined, req: OperationRequest, opClass: OperationClass): boolean {
    if (!token) return false;
    const record = this.authorizations.get(token);
    if (!record) return false;

    // Verify HMAC signature integrity
    const dotIndex = token.indexOf(".");
    if (dotIndex === -1) return false;
    const expectedSig = this.signPayload(
      record.id,
      record.operationClass,
      record.targetPath,
      record.commandHash,
      record.contentHash,
      record.expiresAt
    );
    const providedSig = token.slice(dotIndex + 1);
    if (providedSig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig))) {
      this.authorizations.delete(token);
      return false;
    }

    // Check expiry
    if (Date.now() > record.expiresAt) {
      this.authorizations.delete(token);
      return false;
    }

    // Check usage count
    if (record.usedCount >= record.maxUses) {
      this.authorizations.delete(token);
      return false;
    }

    // Check class hierarchy
    const ranks: Record<OperationClass, number> = {
      read_only: 0,
      routine_edit: 1,
      privileged_edit: 2,
      high_risk: 3,
    };
    if (ranks[record.operationClass] < ranks[opClass]) {
      return false;
    }

    // If token is bound to a specific target path, enforce exact match
    if (record.targetPath && req.target) {
      const resolvedReq = path.resolve(req.target);
      if (record.targetPath !== resolvedReq) {
        return false;
      }
    }

    // If token is bound to a specific command hash, enforce exact match
    if (record.commandHash) {
      const reqCmdHash = req.commandHash || (req.command ? sha256(req.command.trim()) : undefined);
      if (record.commandHash !== reqCmdHash) {
        return false;
      }
    }

    // If token is bound to specific content hash, enforce exact match
    if (record.contentHash) {
      if (record.contentHash !== req.contentHash) {
        return false;
      }
    }

    record.usedCount++;
    if (record.usedCount >= record.maxUses) {
      this.authorizations.delete(token);
    }
    return true;
  }

  authorizeFileOperation(
    filePath: string,
    action: "read" | "write" | "delete",
    authToken?: string,
    contentHash?: string
  ): SecurityCheckResult {
    if (action === "read") {
      return { allowed: true, operationClass: "read_only" };
    }

    const opClass = this.classifyPath(filePath);
    const req: OperationRequest = {
      type: action === "delete" ? "file_delete" : "file_write",
      target: filePath,
      contentHash,
    };

    // 1. High risk paths require explicit high-risk token in all modes
    if (opClass === "high_risk") {
      const authorized = this.validateAuthorization(authToken, req, opClass);
      if (!authorized) {
        return {
          allowed: false,
          operationClass: opClass,
          requiredClass: "high_risk",
          reason: `Target path ${filePath} is classified as HIGH-RISK.`,
          error: `SECURITY_HIGH_RISK_BLOCKED: Explicit authorization token required for ${filePath}`,
        };
      }
      return { allowed: true, operationClass: opClass };
    }

    // 2. Privileged edits require authorization in managed and strict modes
    if (opClass === "privileged_edit") {
      if (this.mode === "managed" || this.mode === "strict") {
        const authorized = this.validateAuthorization(authToken, req, opClass);
        if (!authorized) {
          return {
            allowed: false,
            operationClass: opClass,
            requiredClass: "privileged_edit",
            reason: `Modification of system path ${filePath} requires privileged authorization in ${this.mode} mode.`,
            error: `SECURITY_PRIVILEGE_REQUIRED: Authorization token required for privileged target ${filePath}`,
          };
        }
      }
      return { allowed: true, operationClass: opClass };
    }

    // 3. Routine edits require authorization in strict mode
    if (this.mode === "strict") {
      const authorized = this.validateAuthorization(authToken, req, opClass);
      if (!authorized) {
        return {
          allowed: false,
          operationClass: opClass,
          requiredClass: "routine_edit",
          error: `SECURITY_AUTHORIZATION_REQUIRED: Strict mode requires authorization token for writes`,
        };
      }
    }

    return { allowed: true, operationClass: "routine_edit" };
  }

  authorizeCommand(commandStr: string, authToken?: string): SecurityCheckResult {
    const { operationClass, reason } = this.classifyCommand(commandStr);
    const cmdHash = sha256(commandStr.trim());
    const req: OperationRequest = { type: "command", command: commandStr, commandHash: cmdHash };

    if (operationClass === "read_only") {
      return { allowed: true, operationClass: "read_only" };
    }

    // High risk commands require authorization in all modes
    if (operationClass === "high_risk") {
      const authorized = this.validateAuthorization(authToken, req, operationClass);
      if (!authorized) {
        return {
          allowed: false,
          operationClass: "high_risk",
          requiredClass: "high_risk",
          reason: reason || "High-risk command detected",
          error: `SECURITY_HIGH_RISK_COMMAND_BLOCKED: Command classified as HIGH-RISK (${reason}). Explicit authorization token required.`,
        };
      }
      return { allowed: true, operationClass: "high_risk" };
    }

    // Privileged commands require authorization in managed and strict modes
    if (operationClass === "privileged_edit") {
      if (this.mode === "managed" || this.mode === "strict") {
        const authorized = this.validateAuthorization(authToken, req, operationClass);
        if (!authorized) {
          return {
            allowed: false,
            operationClass: "privileged_edit",
            requiredClass: "privileged_edit",
            reason: reason || "Privileged command detected",
            error: `SECURITY_PRIVILEGED_COMMAND_REQUIRED: Sudo or privileged command (${reason}) requires authorization token in ${this.mode} mode.`,
          };
        }
      }
      return { allowed: true, operationClass: "privileged_edit" };
    }

    // Routine commands require authorization in strict mode
    if (this.mode === "strict") {
      const authorized = this.validateAuthorization(authToken, req, operationClass);
      if (!authorized) {
        return {
          allowed: false,
          operationClass: "routine_edit",
          requiredClass: "routine_edit",
          reason: "Strict mode requires authorization token for command execution",
          error: `SECURITY_AUTHORIZATION_REQUIRED: Strict mode requires authorization token for commands`,
        };
      }
    }

    return { allowed: true, operationClass: "routine_edit" };
  }

  authorizeEval(codeStr: string, authToken?: string): SecurityCheckResult {
    const trimmed = codeStr.trim();
    const req: OperationRequest = { type: "repl_eval", command: trimmed };

    // Check for suspicious sandbox-escape patterns
    const dangerousPatterns = [
      /\b(child_process|binding|dlopen)\b/,
      /process\.(exit|kill|dlopen|binding|mainModule)/,
      /require\s*\(/,
      /import\s*\(/,
      /__proto__|constructor\s*\[\s*['"]constructor['"]\s*\]/,
    ];

    for (const pat of dangerousPatterns) {
      if (pat.test(trimmed)) {
        const authorized = this.validateAuthorization(authToken, req, "high_risk");
        if (!authorized) {
          return {
            allowed: false,
            operationClass: "high_risk",
            requiredClass: "high_risk",
            reason: "Code contains restricted module/process escape sequence",
            error: "SECURITY_HIGH_RISK_BLOCKED: Code evaluation with potential sandbox escape requires high_risk authorization token",
          };
        }
        return { allowed: true, operationClass: "high_risk" };
      }
    }

    if (this.mode === "strict") {
      const authorized = this.validateAuthorization(authToken, req, "routine_edit");
      if (!authorized) {
        return {
          allowed: false,
          operationClass: "routine_edit",
          requiredClass: "routine_edit",
          reason: "Strict mode requires authorization token for REPL evaluation",
          error: "SECURITY_AUTHORIZATION_REQUIRED: Strict mode requires authorization token for node_repl",
        };
      }
    }

    return { allowed: true, operationClass: "routine_edit" };
  }
}

let globalPolicy: SecurityPolicy | null = null;

export function getSecurityPolicy(): SecurityPolicy {
  if (!globalPolicy) {
    globalPolicy = new SecurityPolicy();
  }
  return globalPolicy;
}

export function resetSecurityPolicy(mode?: SecurityMode, secret?: string | Buffer): SecurityPolicy {
  globalPolicy = new SecurityPolicy(mode, secret);
  return globalPolicy;
}
