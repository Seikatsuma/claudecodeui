import { MailX } from 'lucide-react';

import AuthScreenLayout from './AuthScreenLayout';

/**
 * Shown when a `/invite/<token>` link does not resolve to a valid, unused
 * invite - either the token never existed, or someone already registered
 * through it. Deliberately worded differently from the "session expired"
 * screen (see AUTH_ERROR_MESSAGES.inviteInvalid) since these are different
 * situations for the visitor.
 */
export default function InvalidInviteScreen() {
  return (
    <AuthScreenLayout
      title="Invitation not valid"
      description="This invitation link is no longer valid."
      footerText="It may have already been used, or the link may be incomplete. Ask whoever invited you for a new one."
      logo={(
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25 ring-1 ring-inset ring-white/20">
          <MailX className="h-8 w-8 text-primary-foreground" />
        </div>
      )}
    >
      <div />
    </AuthScreenLayout>
  );
}
