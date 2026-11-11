# Temporary identity; load manually with source, never installed automatically.
complete -c bridge-dev -f
complete -c bridge-dev -n __fish_use_subcommand -a 'connect stdio up down status watch clients tasks install uninstall tunnel sudoers doctor config'
complete -c bridge-dev -n '__fish_seen_subcommand_from clients' -a 'list revoke revoke-all'
complete -c bridge-dev -n '__fish_seen_subcommand_from tasks' -a 'status logs stop'
complete -c bridge-dev -n '__fish_seen_subcommand_from install uninstall' -a 'codex claude-code claude-desktop'
complete -c bridge-dev -n '__fish_seen_subcommand_from tunnel' -a setup
complete -c bridge-dev -n '__fish_seen_subcommand_from sudoers' -a 'preview install'
complete -c bridge-dev -n '__fish_seen_subcommand_from config' -a check
complete -c bridge-dev -l mode -r -a 'readonly user sudo dangerous'
complete -c bridge-dev -l approve -r -a 'none sudo write all'
complete -c bridge-dev -l auth -r -a 'oauth code'
complete -c bridge-dev -l tunnel -r -a 'cloudflared none custom:'
complete -c bridge-dev -l task-backend -r -a 'auto systemd detached'
for flag in roots config port idle-timeout sudo-for public-origin redirect-hosts allow-commands deny-commands sudo-commands state-dir issuer read-bytes write-bytes output-bytes task-log-bytes search-results search-visited search-depth exec-timeout exec-max-timeout http-body-bytes http-concurrency oauth-clients oauth-tokens oauth-pending approval-pending
    complete -c bridge-dev -l $flag -r
end
for flag in reconfigure ack-dangerous detach print oauth probe shell headless
    complete -c bridge-dev -l $flag
end
