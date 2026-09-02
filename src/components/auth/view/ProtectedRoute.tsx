import type { ReactNode } from 'react';

import { IS_PLATFORM } from '../../../shared/utils';
import { useAuth } from '../context/AuthContext';
import Onboarding from '../../onboarding/view/Onboarding';

import AuthLoadingScreen from './AuthLoadingScreen';
import InvalidInviteScreen from './InvalidInviteScreen';
import InviteRegisterForm from './InviteRegisterForm';
import LoginForm from './LoginForm';
import LoginLinkRevealScreen from './LoginLinkRevealScreen';
import NoInvitationScreen from './NoInvitationScreen';
import SetupForm from './SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const {
    user,
    isLoading,
    needsSetup,
    hasCompletedOnboarding,
    refreshOnboardingStatus,
    openRegistration,
    pendingLoginLink,
    inviteToken,
    inviteStatus,
  } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  // Shown exactly once, right after a successful registerOpen() - before the
  // normal app is reachable at all, so nobody can skip past it by navigating.
  if (pendingLoginLink) {
    return <LoginLinkRevealScreen />;
  }

  if (openRegistration) {
    // No "already set up" gate here: any number of independent accounts can
    // register on a shared instance, so needsSetup (the single-account gate)
    // does not apply. But unlike before, an anonymous visitor no longer gets
    // a self-service form by default - only a `/invite/<token>` link (see
    // AuthContext) unlocks it, and only while that exact token is still
    // unused. Everything else (bare root, unknown token, already-used token)
    // renders a message, never the registration form.
    if (!user) {
      if (inviteToken) {
        if (inviteStatus === 'checking') {
          return <AuthLoadingScreen />;
        }
        if (inviteStatus === 'valid') {
          return <InviteRegisterForm inviteToken={inviteToken} />;
        }
        return <InvalidInviteScreen />;
      }

      return <NoInvitationScreen />;
    }

    // Skip the Git Configuration / Connect Agents onboarding flow entirely
    // here: it exists to set up a coding workstation, not to gate access to
    // a chat. A multi-tenant visitor is in the app immediately after
    // registering; both are still reachable any time from Settings for
    // whoever actually wants them.
    return <>{children}</>;
  } else {
    if (needsSetup) {
      return <SetupForm />;
    }

    if (!user) {
      return <LoginForm />;
    }
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
