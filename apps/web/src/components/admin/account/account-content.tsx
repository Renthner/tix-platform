import { getOwnAccount, getOwnAlertPreferences, getSetting } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { SettingsSection } from '@/components/admin/settings-forms';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { getCore } from '@/server/core';
import {
  changePasswordAction,
  resetAlertPreferencesAction,
  saveAlertPreferencesAction,
  confirmTwoFactorAction,
  disableTwoFactorAction,
  regenerateRecoveryCodesAction,
  sendEmailVerificationAction,
  startTwoFactorSetupAction,
  updateProfileAction,
} from '@/server/admin/account';
import {
  AlertPreferencesForm,
  EmailVerifyForm,
  PasswordForm,
  ProfileForm,
  TwoFactorPanel,
} from './account-forms';

/** Body of the own-account page (also shown in place of the panel while 2FA setup is enforced). */
export async function AccountContent({
  userId,
  setupRequired,
}: {
  userId: string;
  setupRequired: boolean;
}) {
  const core = getCore();
  const [t, account, security, alertPrefs, alertSettings] = await Promise.all([
    getTranslations('adminSecurity.account'),
    getOwnAccount(core, userId),
    getSetting(core, 'security'),
    getOwnAlertPreferences(core, userId),
    getSetting(core, 'alerts'),
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
          required={account.twoFactorRequired}
          recoveryCodesLeft={account.recoveryCodesLeft}
          startSetup={startTwoFactorSetupAction}
          confirmAction={confirmTwoFactorAction}
          disableAction={disableTwoFactorAction}
          regenerateAction={regenerateRecoveryCodesAction}
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
        </>
      )}
    </div>
  );
}
