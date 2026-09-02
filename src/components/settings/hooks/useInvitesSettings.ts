import { useCallback, useEffect, useState } from 'react';

import { resolveApiErrorMessage } from '../../auth/utils';
import type { CreateInvitePayload, InviteRecord, ListInvitesPayload } from '../../auth/types';
import { api } from '../../../utils/api';
import { copyTextToClipboard } from '../../../utils/clipboard';

const buildInviteLink = (token: string): string => `${window.location.origin}/invite/${token}`;

/**
 * Backs Settings > Invites: any logged-in user on an OPEN_REGISTRATION
 * instance can mint a single-use `/invite/<token>` link here and see which
 * of their own invites have been redeemed (see server/modules/auth). There
 * is no separate admin role - every account gets the same section.
 */
export function useInvitesSettings() {
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const loadInvites = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await api.auth.listInvites();
      const payload = await response.json() as ListInvitesPayload;
      setInvites(response.ok ? (payload.invites ?? []) : []);
    } catch (error) {
      console.error('Error loading invites:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createInvite = useCallback(async (label: string) => {
    try {
      setIsCreating(true);
      setCreateError(null);
      const response = await api.auth.createInvite(label);
      const payload = await response.json() as CreateInvitePayload;

      if (!response.ok || !payload.invite) {
        setCreateError(resolveApiErrorMessage(payload, 'Could not create the invite.'));
        return false;
      }

      setInvites((previous) => [payload.invite as InviteRecord, ...previous]);
      return true;
    } catch (error) {
      console.error('Error creating invite:', error);
      setCreateError('Could not create the invite.');
      return false;
    } finally {
      setIsCreating(false);
    }
  }, []);

  const copyInviteLink = useCallback(async (token: string) => {
    const success = await copyTextToClipboard(buildInviteLink(token));
    if (success) {
      setCopiedToken(token);
      window.setTimeout(() => {
        setCopiedToken((current) => (current === token ? null : current));
      }, 2000);
    }
  }, []);

  useEffect(() => {
    void loadInvites();
  }, [loadInvites]);

  return {
    invites,
    isLoading,
    isCreating,
    createError,
    copiedToken,
    createInvite,
    copyInviteLink,
    buildInviteLink,
  };
}
