/**
 * LFID Sign-In Button for the Portal
 *
 * Injected into the portal sign-in page via the 'sign-in:providers' slot.
 * Triggers Supabase Auth0 OAuth flow which redirects to the LF Auth0 tenant.
 * After successful auth, the portal sign-in page handles the callback
 * via the existing implicit flow handler (access_token in URL hash).
 */

'use client';

import { useState } from 'react';

interface LfidSignInButtonProps {
  /** Supabase client getter — passed from host sign-in page */
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  redirectTo?: string;
  primaryColor?: string;
}

export default function LfidSignInButton({
  redirectTo = '/',
  primaryColor,
}: LfidSignInButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Dynamic import to avoid SSR issues — the portal Supabase client is client-only
      const { getSupabaseClient } = await import('@/lib/supabase/client');
      const supabase = getSupabaseClient();

      // Store redirectTo for the callback handler
      localStorage.setItem('auth_redirect_to', redirectTo);

      const callbackUrl = `${window.location.origin}/sign-in`;

      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'auth0' as any,
        options: {
          redirectTo: callbackUrl,
          scopes: 'openid profile email',
        },
      });

      if (oauthError) {
        setError(oauthError.message);
        setIsLoading(false);
      }
      // If successful, the browser redirects to Auth0
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initiate LFID sign-in');
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full">
      <div className="relative my-5">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-white/20" />
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="bg-transparent px-3 text-white/50">or</span>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSignIn}
        disabled={isLoading}
        className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-lg border border-white/30 bg-white/10 backdrop-blur-sm text-white hover:bg-white/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm"
        style={primaryColor ? { borderColor: `${primaryColor}60` } : undefined}
      >
        {/* LF Logo */}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L2 7v10l10 5 10-5V7L12 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <text x="7" y="16" fontSize="10" fontWeight="bold" fill="currentColor">LF</text>
        </svg>
        {isLoading ? 'Redirecting to LFID...' : 'Sign in with LFID'}
      </button>

      {error && (
        <p className="mt-2 text-sm text-red-300 text-center">{error}</p>
      )}
    </div>
  );
}
