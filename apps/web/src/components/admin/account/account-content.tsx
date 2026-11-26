import {
  getAdminUserActivity,
  getOwnAccount,
  getOwnAlertPreferences,
  getSetting,
  listOwnPasskeys,
  passkeysAvailable,
} from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { SettingsSection } from '@/components/admin/settings-forms';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { getCore } from '@/server/core';
import {
  beginPasskeyRegistrationAction,
  passkeyProofOptionsAction,
  regenerateRecoveryCodesWithPasskeyAction,
  changePasswordAction,
  finishPasskeyRegistrationAction,
  removePasskeyAction,
  renamePasskeyAction,
  resetAlertPreferencesAction,
  saveAlertPreferencesAction,
  confirmTwoFactorAction,
  disableTwoFactorAction,
  regenerateRecoveryCodesAction,
  sendEmailVerificationAction,
  signOutOtherSessionsAction,
  startTwoFactorSetupAction,
  updateProfileAction,
} from '@/server/admin/account';
import {
  AlertPreferencesForm,
  EmailVerifyForm,
  PasswordForm,
  ProfileForm,
  SessionsForm,
  TwoFactorPanel,
} from './account-forms';
import { PasskeyPanel } from './passkey-panel';

/** Body of the own-account page (also shown in place of the panel while 2FA setup is enforced). */
export async function AccountContent({
  userId,
  setupRequired,
}: {
  userId: string;
  setupRequired: boolean;
}) {
  const core = getCore();
  const [t, account, security, alertPrefs, alertSettings, passkeys, activity] = await Promise.all([
    getTranslations('adminSecurity.account'),
    getOwnAccount(core, userId),
    getSetting(core, 'security'),
    getOwnAlertPreferences(core, userId),
    getSetting(core, 'alerts'),
    listOwnPasskeys(core, userId),
    getAdminUserActivity(core, userId),
  ]);
  const ta = await getTranslations('system.alerts');
  return (
    <div className="max-w-3xl space-y-6 p-6">
      {setupRequired && (
        <Alert variant="destructive">
          <AlertDescription>{t('setupRequired')}</AlertDescription>
        </Alert>
      )}
      <SettingsSection
        id="twoFactor"
        title={t('twoFactor.title')}
        description={t('twoFactor.description')}
      >
        <TwoFactorPanel
          enabled={account.twoFactorEnabled}
          // The authenticator app can only be dropped while it is not the last mandatory factor.
          required={account.twoFactorRequired && account.passkeyCount === 0}
          recoveryCodesLeft={account.recoveryCodesLeft}
          startSetup={startTwoFactorSetupAction}
          confirmAction={confirmTwoFactorAction}
          disableAction={disableTwoFactorAction}
          regenerateAction={regenerateRecoveryCodesAction}
        />
      </SettingsSection>
      <SettingsSection
        id="passkeys"
        title={t('passkeys.title')}
        description={t('passkeys.description')}
      >
        <PasskeyPanel
          available={passkeysAvailable(core)}
          passkeys={passkeys.map((p) => ({
            id: p.id,
            name: p.name,
            createdAt: p.createdAt.toISOString(),
            lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
            backedUp: p.backedUp,
          }))}
          // Only the last second factor of a mandatory policy cannot go (same rule as the server).
          removeLocked={
            account.twoFactorRequired && !account.twoFactorEnabled && passkeys.length <= 1
          }
          hasSecondFactor={account.twoFactorEnabled || passkeys.length > 0}
          hasTotp={account.twoFactorEnabled}
          proofOptionsAction={passkeyProofOptionsAction}
          regenerateAction={regenerateRecoveryCodesWithPasskeyAction}
          beginAction={beginPasskeyRegistrationAction}
          finishAction={finishPasskeyRegistrationAction}
          renameAction={renamePasskeyAction}
          removeAction={removePasskeyAction}
        />
      </SettingsSection>
      {!setupRequired && (
        <>
          <SettingsSection
            id="emailVerify"
            title={t('emailVerify.title')}
            description={t('emailVerify.description')}
          >
            <EmailVerifyForm
              action={sendEmailVerificationAction}
              verified={account.emailVerified}
              email={account.email}
            />
          </SettingsSection>
          <SettingsSection
            id="profile"
            title={t('profile.title')}
            description={t('profile.description')}
          >
            <ProfileForm
              action={updateProfileAction}
              displayName={account.displayName}
              email={account.email}
            />
          </SettingsSection>
          <SettingsSection
            id="alerts"
            title={ta('account.title')}
            description={ta('account.description')}
          >
            <AlertPreferencesForm
              saveAction={saveAlertPreferencesAction}
              resetAction={resetAlertPreferencesAction}
              selectable={alertPrefs.selectable}
              selected={alertPrefs.selected}
              isDefault={alertPrefs.isDefault}
              globallyEnabled={alertSettings.enabled}
            />
          </SettingsSection>
          <SettingsSection
            id="password"
            title={t('password.title')}
            description={t('password.description')}
          >
            <PasswordForm action={changePasswordAction} minLength={security.minPasswordLength} />
          </SettingsSection>
          <SettingsSection
            id="sessions"
            title={t('sessions.title')}
            description={t('sessions.description')}
          >
            <SessionsForm
              action={signOutOtherSessionsAction}
              activeSessions={activity.activeSessions}
            />
          </SettingsSection>
        </>
      )}
    </div>
  );
}
