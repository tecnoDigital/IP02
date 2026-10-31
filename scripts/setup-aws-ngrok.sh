#!/usr/bin/env bash
# Review this script before running it with sudo. It does not install dependencies.
set -euo pipefail
set +x
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset NODE_OPTIONS NODE_PATH
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'Run with sudo after building as your normal deployment user.'
[[ $# == 1 ]] || fail 'Usage: sudo bash scripts/setup-aws-ngrok.sh DOMAIN (hostname only)'
domain=$1
[[ ${#domain} -le 253 && $domain =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$ ]] || fail 'Supply a lowercase dashboard domain, without scheme, path or port.'
[[ $(lsb_release -rs) == 24.04 && $(lsb_release -is) == Ubuntu ]] || fail 'Ubuntu 24.04 is required.'
[[ -d /run/systemd/system ]] || fail 'systemd is required.'
deploy=${SUDO_USER:-}
[[ $deploy =~ ^[a-z_][a-z0-9_-]*$ && $deploy != root ]] || fail 'Use sudo from a normal deployment account.'
[[ $(id -u "$deploy") -ge 1000 ]] || fail 'A normal deployment account is required.'
app=/opt/ip2
[[ -d $app && ! -L $app && $(realpath "$app") == "$app" && $(stat -c %U "$app") == "$deploy" ]] || fail '/opt/ip2 must be a real checkout owned by the sudo caller.'
[[ $(stat -c %a "$app") == 755 ]] || fail 'Set /opt/ip2 permissions to 755; do not grant public write access.'
[[ -f $app/dist/server.cjs && -f $app/dist/frontend/index.html ]] || fail 'Run npm ci and npm run build as the deployment user first.'
for tool in node ngrok curl runuser install systemctl ss; do command -v "$tool" >/dev/null || fail "Missing prerequisite: $tool"; done
node=$(command -v node)
ngrok=$(command -v ngrok)
# Never execute a user-managed runtime as root, including symlinks into home directories.
for executable in "$node" "$ngrok"; do
  resolved=$(realpath "$executable")
  [[ $resolved =~ ^/(usr/bin|usr/local/bin)/[a-zA-Z0-9._-]+$ ]] || fail 'Install node and ngrok in a trusted system bin directory.'
  for path in /usr /usr/bin /usr/local /usr/local/bin "$resolved"; do
    [[ $(stat -c %u "$path") == 0 && -z $(find "$path" -maxdepth 0 -perm /022 -print) ]] || fail 'Runtime binaries and parents must be root-owned and not group/world writable.'
  done
done
[[ $("$node" --version) == v24.18.0 ]] || fail 'Install Node 24.18.0, matching package.json, before setup.'
"$ngrok" version >/dev/null

for service in ip2 ip2-ngrok; do
  unit=/etc/systemd/system/$service.service
  [[ ! -L $unit ]] || fail "Refusing symlink: $unit"
  if [[ -e $unit ]]; then
    [[ -f $unit && $(stat -c %U:%G:%a:%h "$unit") == root:root:644:1 ]] && grep -qx '# Managed by ip2 setup-aws-ngrok.sh' "$unit" || fail "Unmanaged unit exists: $unit"
  elif systemctl cat "$service.service" >/dev/null 2>&1; then
    fail "An existing $service service must be reviewed manually."
  fi
  if id "$service" >/dev/null 2>&1; then
    [[ $(id -u "$service") -lt 1000 && $(getent passwd "$service" | cut -d: -f6-7) == /nonexistent:/usr/sbin/nologin && $(id -gn "$service") == "$service" ]] || fail "Refusing an unexpected existing account: $service"
  else
    getent group "$service" >/dev/null && fail "Unexpected existing group: $service"
    useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin "$service"
  fi
done

protected_dir() {
  local path=$1 group=$2
  [[ ! -L $path ]] || fail "Refusing symlink: $path"
  if [[ -e $path ]]; then
    [[ -d $path && $(stat -c %U:%G:%a "$path") == "root:$group:750" ]] || fail "Unexpected directory permissions: $path"
  else
    install -d -o root -g "$group" -m 750 "$path"
  fi
}
protected_dir /etc/ip2 ip2
protected_dir /etc/ip2-ngrok ip2-ngrok
[[ ! -L /var/lib/ip2 ]] || fail 'Refusing a symlink at /var/lib/ip2.'
if [[ -e /var/lib/ip2 ]]; then
  [[ -d /var/lib/ip2 && $(stat -c %U:%G:%a /var/lib/ip2) == ip2:ip2:750 ]] || fail 'Review existing /var/lib/ip2 ownership and permissions manually.'
else
  install -d -o ip2 -g ip2 -m 750 /var/lib/ip2
fi
for database_file in /var/lib/ip2/ip2.db{,-wal,-shm}; do
  [[ ! -L $database_file ]] || fail 'Refusing a database symlink.'
  if [[ -e $database_file ]]; then
    [[ -f $database_file && $(stat -c %U:%h "$database_file") == ip2:1 ]] || fail 'Review existing database ownership and hard links manually.'
  fi
done

envfile=/etc/ip2/app.env
[[ ! -L $envfile ]] || fail 'Refusing an app.env symlink.'
if [[ ! -e $envfile ]]; then
  [[ -f $app/.env && ! -L $app/.env && $(stat -c %U:%a:%h "$app/.env") == "$deploy:600:1" ]] || fail 'Prepare /opt/ip2/.env as the deployment user with mode 600.'
  install -o root -g ip2 -m 640 "$app/.env" "$envfile"
fi
[[ -f $envfile && $(stat -c %U:%G:%a:%h "$envfile") == root:ip2:640:1 ]] || fail 'app.env must be root:ip2, mode 640, without hard links.'
# Node parses dotenv data; never source it or execute checkout code as root.
runuser -u ip2 -- env -i PATH="$PATH" "$node" -e '
process.loadEnvFile(process.argv[2]);
const e = process.env;
const required = ["RETELL_API_KEY", "RETELL_WEBHOOK_KEY", "RETELL_FROM_NUMBER", "RETELL_AGENT_ID", "ADMIN_PASSWORD_HASH", "SESSION_SECRET"];
const valid = required.every(k => e[k]?.trim()) && e.SESSION_SECRET.length >= 32
  && /^scrypt\$[^$]+\$[^$]+$/.test(e.ADMIN_PASSWORD_HASH)
  && e.HOST === "127.0.0.1" && e.PORT === "3000" && e.NODE_ENV === "production"
  && e.DATABASE_PATH === "/var/lib/ip2/ip2.db" && e.APP_BASE_URL === "https://" + process.argv[1]
  && !e.NODE_OPTIONS && !e.NODE_PATH;
if (!valid) { console.error("Invalid deployment environment. Review required values in the guide; values are not printed."); process.exit(1); }
' "$domain" "$envfile" >/dev/null 2>&1 || fail 'Invalid deployment environment. Review /etc/ip2/app.env against the guide; values are not printed.'

config=/etc/ip2-ngrok/ngrok.yml
[[ ! -L $config ]] || fail 'Refusing an ngrok config symlink.'
if [[ ! -e $config ]]; then
  [[ -t 0 ]] || fail 'An interactive terminal is required for the hidden ngrok token prompt.'
  read -r -s -p 'ngrok authtoken (hidden): ' token
  printf '\n'
  [[ $token =~ ^[a-zA-Z0-9_-]+$ ]] || fail 'Unexpected token format; no token was saved.'
  printf 'version: 3\nagent:\n  authtoken: %s\n  web_addr: false\n  inspect_db_size: -1\n  console_ui: false\n  log: stdout\n  log_level: warn\n  remote_management: false\n  update_check: false\n' "$token" > "$config"
  unset token
  chown root:ip2-ngrok "$config"
  chmod 640 "$config"
fi
[[ -f $config && $(stat -c %U:%G:%a:%h "$config") == root:ip2-ngrok:640:1 ]] || fail 'ngrok.yml must be root:ip2-ngrok, mode 640, without hard links.'
runuser -u ip2-ngrok -- "$ngrok" config check --config "$config" >/dev/null 2>&1 || fail 'ngrok config validation failed; review protected config manually.'
grep -qx '  web_addr: false' "$config" && grep -qx '  inspect_db_size: -1' "$config" || fail 'Keep ngrok inspection disabled in the protected config.'
runuser -u ip2 -- test -r "$app/dist/server.cjs" || fail 'The ip2 user cannot read the build; check parent directory permissions.'

cat > /etc/systemd/system/ip2.service <<EOF
# Managed by ip2 setup-aws-ngrok.sh
[Unit]
Description=IP2 Retell dashboard
After=network-online.target
Wants=network-online.target
[Service]
User=ip2
Group=ip2
WorkingDirectory=$app
Environment=NODE_ENV=production
ExecStart=$node --env-file=$envfile $app/dist/server.cjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/ip2
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/ip2-ngrok.service <<EOF
# Managed by ip2 setup-aws-ngrok.sh
[Unit]
Description=IP2 ngrok HTTPS tunnel
After=network-online.target ip2.service
Wants=network-online.target ip2.service
[Service]
User=ip2-ngrok
Group=ip2-ngrok
ExecStart=$ngrok http http://127.0.0.1:3000 --url=https://$domain --config=$config --inspect=false
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
[Install]
WantedBy=multi-user.target
EOF
chmod 644 /etc/systemd/system/ip2{,-ngrok}.service
systemctl daemon-reload
# Close any old tunnel while checking the backend. Failure leaves it closed.
systemctl disable --now ip2-ngrok.service
systemctl restart ip2.service
healthy=false
for ((attempt=0; attempt<30; attempt++)); do
  pid=$(systemctl show -p MainPID --value ip2.service)
  listener=$(ss -H -ltnp 'sport = :3000')
  if [[ $pid != 0 && $listener == *"127.0.0.1:3000"* && $listener == *"pid=$pid,"* ]] && systemctl is-active --quiet ip2.service && curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:3000/api/health | grep -qx '{"status":"ok"}'; then
    healthy=true; break
  fi
  sleep 1
done
[[ $healthy == true ]] || fail 'Local health check failed. Tunnel remains stopped. Review journalctl -u ip2; do not reset the database.'
systemctl enable ip2.service ip2-ngrok.service
systemctl restart ip2-ngrok.service
printf '%s\n' 'Local health check passed; services enabled. Verify the public HTTPS URL and login manually.' 'Existing protected environment, token and database were preserved. No public health check was performed.'
