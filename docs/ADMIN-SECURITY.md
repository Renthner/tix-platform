# Admin sign-in security: passkeys and two-factor authentication

Admin users sign in with e-mail + password. On top of that there are two kinds of second factor,
and either one satisfies a "two-factor authentication is mandatory" policy:

- an **authenticator app** (TOTP, with 10 single-use recovery codes), and
- **passkeys** (WebAuthn: fingerprint, face, device PIN or a hardware security key).

## Passkeys

Own passkeys are managed under **My account → Passkeys** (click your name at the bottom left of the
admin menu): add (give it a name), rename and remove. Up to 10 per user.

Signing in:

- **Sign in with a passkey** on the admin login page: no password needed. The passkey is always
  used with _user verification_ (fingerprint/face/PIN), so it counts as password + second factor in
  one step and the session is marked as second-factor verified.
- **Password first, passkey as the second step:** if the user has a passkey or an authenticator
  app, the password alone never opens a session. On the second step the user can type a code or
  press **Use a passkey instead**.

Rules and safeguards:

- Adding and removing a passkey needs the **current password** (rate limited), also from a
  signed-in session.
- A user cannot remove the **last second factor** while two-factor authentication is mandatory for
  them (and cannot turn off the authenticator app if no passkey remains).
- The first passkey of a user without recovery codes generates a set of **recovery codes**, shown
  once. A recovery code works in the second step like for TOTP users.
- A signature counter that does not advance (cloned authenticator) is rejected and audited as
  `admin_user.passkey_clone_suspected`. Synced passkeys always report counter 0 and are accepted.
- Failed passkey verifications of a known account count towards the same lockout as wrong
  passwords/codes (Settings → Security). Per-IP rate limits apply to the options and verify steps.
- Audit entries: `admin_user.passkey_registered`, `admin_user.passkey_renamed`,
  `admin_user.passkey_removed`, `admin_user.passkey_login` (successful sign-in, in place of
  `admin_user.login`), `admin_user.passkey_clone_suspected`; failed verifications appear as
  `admin_user.login_failed` / `admin_user.locked` with `method: passkey`.

### Requirements

WebAuthn is bound to the **public address** of the installation (`APP_URL`): the relying party ID is
its host name and the only accepted origin is exactly that URL; request headers are never used.
Passkeys therefore need `APP_URL` to be `https://<domain name>` (or `http://localhost`). With an IP
address or plain http the passkey buttons are hidden and the account page explains why.
**Changing the domain makes existing passkeys unusable** (they are bound to the old host name):
sign in with the password and the authenticator app / recovery codes and register the passkeys
again.

## Mandatory two-factor authentication

**Settings → Security** has two switches:

| Setting                                              | Effect                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| Two-factor authentication mandatory                  | every admin needs an authenticator app **or** a passkey        |
| Two-factor authentication mandatory for super admins | only users with the Super admin role (new, **off by default**) |

A user without a second factor is redirected to **My account** right after signing in and cannot
use anything else until one is set up. Turn the super-admin switch on only after every super admin
has a second factor, otherwise they all land in that setup screen at the next sign-in (which works
as intended, but the person turning the switch on should have set theirs up first).

## Role matrix for orders and money

SUPER_ADMIN may do everything. For the other roles:

| Action                                                                                                 | Event manager | Finance | Door staff |
| ------------------------------------------------------------------------------------------------------ | :-----------: | :-----: | :--------: |
| View orders, resend e-mails / tickets, internal note, keep reserved                                    |      yes      |   yes   |     no     |
| Cancel unpaid orders                                                                                   |      yes      |   yes   |     no     |
| Cancel paid orders / single tickets (credit note, refund rows)                                         |      yes      |   yes   |     no     |
| Record bank / cash / card payments (also for additional payments)                                      |      yes      |   yes   |     no     |
| Change the buyer e-mail of an order, message the buyer of one order, send a failed order e-mail again  |      yes      |   yes   |     no     |
| Message all buyers of an event (event mailing, incl. test mail), postpone an event (with buyer notice) |      yes      |   no    |     no     |
| Event cancellation assistant (cancel event, refund all orders)                                         |      yes      |   no    |     no     |
| Mark refunds as done, retry refunds, refund overpayments, reverse bank allocations                     |      no       |   yes   |     no     |
| Banking, accounting export, fees and tax rates (editing)                                               |      no       |   yes   |     no     |

Event mailings, postponement and the cancellation assistant live on the event, so they follow the
event permission (event managers); finance only writes to the buyer of a single order. The refunds
the cancellation assistant creates are worked off by finance as usual ("Open refunds").
Test orders and the e-mail templates are super-admin only.

## Recovery paths

| Situation                                        | What to do                                                                                                                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lost the authenticator app, passkeys still work  | sign in with a passkey, **My account**, set up a new authenticator                                                                                                                                                                                  |
| Lost the passkey device, authenticator app works | sign in with password + code, remove the passkey                                                                                                                                                                                                    |
| Lost everything, recovery codes available        | password + a recovery code (single use), then set up a new factor                                                                                                                                                                                   |
| Lost everything, another super admin exists      | **Users → user → Reset two-factor authentication**: removes the authenticator app, the recovery codes **and all passkeys** and ends the user's sessions (a lost or stolen device must not keep working)                                             |
| Last super admin locked out                      | on the server: `docker compose run --rm tix create-admin --email <address> --name "<name>" --reset` (development: `pnpm admin:create ... --reset`). It prints a new password and likewise clears the authenticator, recovery codes and all passkeys |

**Restoring a backup** (Settings → Backups) needs the password, the acknowledgement and, when the
account has a second factor, either an authenticator / recovery code or a fresh passkey
confirmation ("Restore with passkey": user verification required, the challenge is bound to the
signed-in admin and that one backup, valid for 2 minutes and single use). An account whose only
second factor is a passkey can therefore restore without an authenticator app. With
"Restoring requires two-factor authentication" on, either kind of second factor satisfies it.

## Network trust

Admin sessions, rate limits and the audit log rely on the visitor address and the scheme the proxy
reports. Set `TRUSTED_PROXIES` to the exact IP/CIDR of your reverse proxy (an `https://` `APP_URL`
always has one in front) and publish port 8080 only on the proxy's interface. Direct access with a
foreign `Host` (for example `http://<server-ip>:8080`) gets 421 unless listed in `TIX_ALLOWED_HOSTS`.
See [INSTALL.md](INSTALL.md#built-in-proxy-host-check-and-limits).

## Backups from another system

A restore runs the archive's SQL as the database user (a superuser in the stock image). Entering the key of
another system lets a SUPER_ADMIN supply an archive under their own key, so that option is disabled unless the
operator sets `TIX_ALLOW_FOREIGN_BACKUP_KEYS=1`. **With it on, a SUPER_ADMIN has the power of the database
superuser (arbitrary SQL).** Enable it only for the migration and only for fully trusted SUPER_ADMINs. See
[BACKUP.md](BACKUP.md#restoring-a-backup-from-another-system).
