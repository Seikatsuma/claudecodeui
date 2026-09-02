import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { Loader2, Sparkles, User } from 'lucide-react';

import { useAuth } from '../context/AuthContext';

import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

/**
 * Account creation screen for an OPEN_REGISTRATION instance: anyone can
 * create their own isolated account here, no invite/approval step. There is
 * no password field - registerOpen() issues a persistent login-link token
 * instead, shown once right after this succeeds (see LoginLinkRevealScreen).
 */
export default function OpenRegisterForm() {
  const { error: sessionError, registerOpen } = useAuth();

  const [username, setUsername] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');
      setIsSubmitting(true);
      const result = await registerOpen(username.trim());
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [registerOpen, username],
  );

  return (
    <AuthScreenLayout
      title="Create your account"
      description="No password to remember - you'll get a personal link to sign back in."
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
