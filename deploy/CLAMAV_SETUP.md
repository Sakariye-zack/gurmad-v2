# Turning on virus scanning (ClamAV) — production droplet

The code is already in place and **off by default** (`CLAMAV_ENABLED` unset). Nothing changes
until ClamAV is installed and the flag is switched on.

ClamAV needs about 1.1–1.5 GB of RAM once its signatures are loaded. The droplet has 2 GB and
no swap, so do ONE of these first:

* resize the droplet to 4 GB (safest), or
* add a 2 GB swap file:

      sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
      sudo mkswap /swapfile && sudo swapon /swapfile
      echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

## 1. Install and start

    sudo apt-get update
    sudo apt-get install -y clamav-daemon
    sudo systemctl stop clamav-freshclam && sudo freshclam   # first signature download
    sudo systemctl start clamav-freshclam
    sudo systemctl enable --now clamav-daemon
    systemctl is-active clamav-daemon                         # expect: active

(The first start can take a minute while signatures load.)

## 2. Let the app user reach the socket

    sudo usermod -aG clamav zakariye
    ls -l /var/run/clamav/clamd.ctl                            # srw-rw---- clamav clamav

Then restart pm2 so the new group is picked up: `pm2 restart gurmad-v2-api`
(if the group is not applied, log out and back in over SSH first).

## 3. Switch it on

Add to `~/gurmad-v2/server/.env`:

    CLAMAV_ENABLED=true
    CLAMAV_FAIL_MODE=open        # open = allow + log if clamd is down; closed = reject uploads

    pm2 restart gurmad-v2-api --update-env

## 4. Verify

Upload the EICAR test string (a harmless antivirus test file) as a document: it must be rejected
with "This file was rejected because it contains malware." and an `upload.virus_detected` entry
must appear in Audit & Security. A normal PDF must still upload.

    printf '%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > eicar.txt

Rename it to `eicar.pdf` — note the magic-byte check will reject a plain-text "pdf" first, so for an
end-to-end check prepend `%PDF-1.4` on the first line.

## Rolling back

Set `CLAMAV_ENABLED=false` (or remove the line) and `pm2 restart gurmad-v2-api --update-env`.
