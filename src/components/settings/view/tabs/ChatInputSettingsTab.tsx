import { useTranslation } from 'react-i18next';

import { useUiPreferences } from '../../../../hooks/useUiPreferences';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

/**
 * Former quick-settings-panel content (the right-edge drag handle/drawer,
 * see project history), moved here per the task brief: it was rarely used
 * and cluttered the chat view. Dark mode, language, and voice enable/disable
 * already have a home in AppearanceSettingsTab/VoiceSettingsTab, so only the
 * toggles that had no other Settings home come along - tool display
 * (raw parameters / thinking) and the Ctrl+Enter send behavior. Reuses the
 * `quickSettings.*` i18n keys (settings.json) rather than duplicating
 * already-translated strings under a new namespace.
 */
export default function ChatInputSettingsTab() {
  const { t } = useTranslation('settings');
  const { preferences, setPreference } = useUiPreferences();

  return (
    <div className="space-y-8">
      <SettingsSection title={t('quickSettings.sections.toolDisplay')}>
        <SettingsCard divided>
          <SettingsRow label={t('quickSettings.showRawParameters')}>
            <SettingsToggle
              checked={preferences.showRawParameters}
              onChange={(value) => setPreference('showRawParameters', value)}
              ariaLabel={t('quickSettings.showRawParameters')}
            />
          </SettingsRow>

          <SettingsRow label={t('quickSettings.showThinking')}>
            <SettingsToggle
              checked={preferences.showThinking}
              onChange={(value) => setPreference('showThinking', value)}
              ariaLabel={t('quickSettings.showThinking')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('quickSettings.sections.inputSettings')}>
        <SettingsCard>
          <SettingsRow
            label={t('quickSettings.sendByCtrlEnter')}
            description={t('quickSettings.sendByCtrlEnterDescription')}
          >
            <SettingsToggle
              checked={preferences.sendByCtrlEnter}
              onChange={(value) => setPreference('sendByCtrlEnter', value)}
              ariaLabel={t('quickSettings.sendByCtrlEnter')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
