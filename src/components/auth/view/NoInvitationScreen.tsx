import { Mail } from 'lucide-react';

import AuthScreenLayout from './AuthScreenLayout';

/**
 * Shown at the bare root address on an OPEN_REGISTRATION instance when the
 * visitor did not arrive through a `/invite/<token>` link. There is no
 * self-service "create your account" form here any more - registration only
 * ever opens up for someone holding a specific invite link (see Settings >
 * Invites, and InviteRegisterForm).
 */
export default function NoInvitationScreen() {
  return (
    <AuthScreenLayout
      title="Invitation only"
      description="You need an invitation link to join. Ask whoever invited you for the link."
      footerText="If you were told to expect access, double-check the exact link you were sent - it only works once."
      logo={(
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25 ring-1 ring-inset ring-white/20">
          <Mail className="h-8 w-8 text-primary-foreground" />
        </div>
      )}
    >
      <div />
    </AuthScreenLayout>
  );
}
