/**
 * LFID Sign-In Button for the Admin UI
 *
 * Injected into the admin sign-in page via the 'sign-in:providers' slot.
 * Triggers Supabase Auth0 OAuth flow which redirects to the LF Auth0 tenant.
 * After successful auth, Supabase creates/links the session and the admin
 * auth context picks it up via onAuthStateChange.
 */

import { useState } from 'react';
import { getSupabase } from '@/lib/supabase';

export default function LfidSignInButton() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const supabase = getSupabase();
      const redirectTo = `${window.location.origin}/login`;

      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'auth0' as any,
        options: {
          redirectTo,
          scopes: 'openid profile email',
        },
      });

      if (oauthError) {
        setError(oauthError.message);
        setIsLoading(false);
      }
      // If successful, the browser redirects to Auth0 — no need to clear loading
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initiate LFID sign-in');
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full">
      <div className="relative my-4">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-gray-200 dark:border-gray-700" />
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="bg-white dark:bg-gray-900 px-2 text-gray-500">or</span>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSignIn}
        disabled={isLoading}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm"
      >
        {/* LF Logo */}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L2 7v10l10 5 10-5V7L12 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <text x="7" y="16" fontSize="10" fontWeight="bold" fill="currentColor">LF</text>
        </svg>
        {isLoading ? 'Redirecting to LFID...' : 'Sign in with LFID'}
      </button>

      {error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400 text-center">{error}</p>
      )}
    </div>
  );
}
