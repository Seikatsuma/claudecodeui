import { useCallback, useState } from 'react';
import { Check, Copy, Plus, UserPlus } from 'lucide-react';

import { Button, Input } from '../../../../../../shared/view/ui';
import { useInvitesSettings } from '../../../../hooks/useInvitesSettings';
import SettingsCard from '../../../SettingsCard';

/**
 * OPEN_REGISTRATION-only: lets any logged-in user on this instance invite
 * someone new. Each "Create invite link" click mints one single-use
 * `/invite/<token>` link; the list below shows every invite this user has
 * created, whether it has been redeemed yet, and by whom. There is no
 * separate "admin" concept - anyone here can invite anyone else.
 */
export default function InvitesSection() {
  const {
    invites,
    isLoading,
    isCreating,
    createError,
    copiedToken,
    createInvite,
    copyInviteLink,
    buildInviteLink,
  } = useInvitesSettings();

  const [showNewInviteForm, setShowNewInviteForm] = useState(false);
  const [label, setLabel] = useState('');

  const handleCreate = useCallback(async () => {
    const success = await createInvite(label);
    if (success) {
      setLabel('');
      setShowNewInviteForm(false);
    }
  }, [createInvite, label]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserPlus className="h-5 w-5" />
          <h3 className="text-lg font-semibold">Invites</h3>
        </div>
        <Button size="sm" onClick={() => setShowNewInviteForm(!showNewInviteForm)}>
          <Plus className="mr-1 h-4 w-4" />
          Create invite link
        </Button>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">
        Invite someone else to this instance. Each link works exactly once - share it directly with the person it is
        for.
      </p>

      {showNewInviteForm && (
        <div className="mb-4 rounded-lg border bg-card p-4">
          <Input
            placeholder="Label / note (optional, e.g. 'for Ivanov')"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            className="mb-2"
            maxLength={200}
          />
          {createError && <p className="mb-2 text-sm text-destructive">{createError}</p>}
          <div className="flex gap-2">
            <Button disabled={isCreating} onClick={() => void handleCreate()}>
              {isCreating ? 'Creating...' : 'Create invite'}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setShowNewInviteForm(false);
                setLabel('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <SettingsCard className="p-4">
        <div className="space-y-2">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : invites.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">No invites yet.</p>
          ) : (
            invites.map((invite) => (
              <div key={invite.token} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{invite.label || 'Untitled invite'}</div>
                    <p className="break-all font-mono text-xs text-muted-foreground">{buildInviteLink(invite.token)}</p>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Created {new Date(invite.createdAt).toLocaleString()}
                      {invite.usedAt && (
                        <>
                          {' '}
                          - used {new Date(invite.usedAt).toLocaleString()}
                          {invite.usedByUsername ? ` by ${invite.usedByUsername}` : ''}
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {invite.usedAt ? (
                      <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                        Used
                      </span>
                    ) : (
                      <>
                        <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                          Not used
                        </span>
                        <Button size="sm" variant="outline" onClick={() => void copyInviteLink(invite.token)}>
                          {copiedToken === invite.token ? (
                            <>
                              <Check className="mr-1 h-4 w-4" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="mr-1 h-4 w-4" />
                              Copy
                            </>
                          )}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
