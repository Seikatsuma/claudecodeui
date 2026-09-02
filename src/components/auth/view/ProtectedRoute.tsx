import type { ReactNode } from 'react';

import { IS_PLATFORM } from '../../../shared/utils';
import { useAuth } from '../context/AuthContext';
import Onboarding from '../../onboarding/view/Onboarding';

import AuthLoadingScreen from './AuthLoadingScreen';
import LoginForm from './LoginForm';
import LoginLinkRevealScreen from './LoginLinkRevealScreen';
import OpenRegisterForm from './OpenRegisterForm';
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
    // does not apply - anyone signed out sees the same registration screen.
    if (!user) {
      return <OpenRegisterForm />;
    }
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
