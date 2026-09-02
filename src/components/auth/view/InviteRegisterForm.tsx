import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { Loader2, Sparkles, User } from 'lucide-react';

import { useAuth } from '../context/AuthContext';

import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type InviteRegisterFormProps = {
  /** The single-use invite token from the `/invite/<token>` URL, already confirmed valid by ProtectedRoute. */
  inviteToken: string;
};

/**
 * Account creation screen for an OPEN_REGISTRATION instance, reachable only
 * through a valid, unused `/invite/<token>` link (see ProtectedRoute) - there
 * is no bare "create your account" screen at the root address any more.
 * There is no password field - registerOpen() issues a persistent login-link
 * token instead, shown once right after this succeeds (see
 * LoginLinkRevealScreen). Submitting consumes the invite token; it cannot be
 * used again after this.
 */
export default function InviteRegisterForm({ inviteToken }: InviteRegisterFormProps) {
  const { error: sessionError, registerOpen } = useAuth();

  const [username, setUsername] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');
      setIsSubmitting(true);
      const result = await registerOpen(username.trim(), inviteToken);
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [registerOpen, username, inviteToken],
  );

  return (
    <AuthScreenLayout
      title="Create your account"
      description="You've been invited. No password to remember - you'll get a personal link to sign back in."
      footerText="Your account gets its own private, empty workspace. Nobody else can see your projects or chats."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="username"
          name="username"
          label="Display name (optional)"
          value={username}
          onChange={setUsername}
          placeholder="How should we call you?"
          isDisabled={isSubmitting}
          autoComplete="username"
          icon={User}
        />

        <AuthErrorAlert errorMessage={errorMessage || sessionError || ''} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:shadow-primary/30 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating your account...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              Create my account
            </>
          )}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
