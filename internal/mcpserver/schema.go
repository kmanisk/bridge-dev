package mcpserver

// inputSchema exposes only meaningful parameters and requires operation inputs.
func inputSchema(name string, privileged bool) map[string]any {
	fields := []string{}
	required := []string{}
	switch name {
	case "fs_list":
		fields = []string{"path", "offset", "limit"}
		required = []string{"path"}
	case "fs_read":
		fields = []string{"path", "offset", "limit"}
		required = []string{"path"}
	case "fetch":
		fields = []string{"id", "offset", "limit"}
		required = []string{"id"}
	case "search", "fs_search":
		fields = []string{"path", "query", "offset", "limit", "content_search"}
	case "fs_write":
		fields = []string{"path", "content", "encoding"}
		required = []string{"path", "content"}
	case "shell":
		fields = []string{"content", "cwd", "timeout_seconds"}
		required = []string{"content", "cwd"}
	case "fs_edit":
		fields = []string{"path", "old", "new"}
		required = fields
	case "exec", "sudo_exec":
		fields = []string{"argv", "cwd", "timeout_seconds"}
		required = []string{"argv", "cwd"}
	case "task_start":
		fields = []string{"argv", "cwd"}
		if privileged {
			fields = append(fields, "sudo")
		}
		required = []string{"argv", "cwd"}
	case "task_status", "task_stop", "task_restart", "task_forget":
		fields = []string{"id"}
		required = fields
	case "task_logs":
		fields = []string{"id", "offset"}
		required = []string{"id"}
	case "task_wait", "approval_status":
		fields = []string{"id", "timeout_seconds"}
		required = []string{"id"}
	}
	fields = append(fields, "client_id", "ack", "request_key")
	switch name {
	case "fs_write", "fs_edit", "exec", "sudo_exec", "task_start", "task_stop", "task_restart", "task_forget", "shell":
		required = append(required, "request_key")
	}
	properties := map[string]any{}
	for _, f := range fields {
		v := map[string]any{"type": "string"}
		switch f {
		case "argv":
			v = map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "minItems": 1, "maxItems": 256}
		case "offset", "limit":
			v = map[string]any{"type": "integer", "minimum": 0}
		case "timeout_seconds":
			v = map[string]any{"type": "integer", "minimum": 0}
			if name == "task_wait" || name == "approval_status" {
				v["maximum"] = 25
			}
		case "encoding":
			v["enum"] = []string{"utf8", "base64"}
		case "query":
			v["maxLength"] = 256
		case "sudo", "content_search":
			v = map[string]any{"type": "boolean"}
		case "client_id":
			v["maxLength"] = 128
		}
		properties[f] = v
	}
	return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
}
