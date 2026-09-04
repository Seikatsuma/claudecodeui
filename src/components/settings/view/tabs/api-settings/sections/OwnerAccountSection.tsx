import { Check, UserRound } from 'lucide-react';

import { useOwnerAccountSettings } from '../../../../hooks/useOwnerAccountSettings';
import { Badge, Button } from '../../../../../../shared/view/ui';
import SettingsCard from '../../../SettingsCard';

/**
 * Platform-owner-only: lets the single owner user switch between their two
 * real Anthropic OAuth sessions (Account 1 / Account 2). Only rendered when
 * the owner-accounts endpoint returns at least one available account, which
 * only happens for the user whose id is in PLATFORM_OWNER_WEB_USER_IDS.
 *
 * This is entirely separate from the "Anthropic Accounts" (API key/BYOK)
 * section used by other invited users — different concept, different data
 * source, different gate.
 */
export default function OwnerAccountSection() {
  const { isLoading, activeSlot, accounts, pendingSlot, errorMessage, activateSlot } =
    useOwnerAccountSettings();

  // Hide while loading and for non-owner users (empty accounts list).
  const availableAccounts = accounts.filter((a) => a.available);
  if (isLoading || availableAccounts.length === 0) {
    return null;
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <UserRound className="h-5 w-5" />
        <h3 className="text-lg font-semibold">Your Claude Accounts</h3>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">
        Switch which of your personal Anthropic OAuth sessions this instance
        uses. The active account applies to all new chat turns immediately.
        The page will reload after switching.
      </p>

      <SettingsCard className="p-4">
        <div className="space-y-2">
          {availableAccounts.map((account) => {
            const isActive = account.slot === activeSlot;
            const isBusy = pendingSlot === account.slot;
            return (
              <div
                key={account.slot}
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-muted-foreground">
                      Account {account.slot}
                    </span>
                    {isActive && (
                      <Badge className="shrink-0 gap-1 border-transparent bg-green-600 text-white dark:bg-green-500">
                        <Check className="h-3 w-3" />
                        Active
                      </Badge>
                    )}
                  </div>
                  {account.email && (
                    <span className="block truncate text-sm font-medium">
                      {account.email}
                    </span>
                  )}
                </div>

                {!isActive && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void activateSlot(account.slot)}
                    disabled={isBusy || pendingSlot !== null}
                  >
                    {isBusy ? 'Switching...' : 'Make active'}
                  </Button>
                )}
              </div>
            );
          })}

          {errorMessage && (
            <p className="text-sm text-destructive">{errorMessage}</p>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
