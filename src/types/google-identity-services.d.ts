declare namespace google.accounts.oauth2 {
  type TokenResponse = {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  type TokenClient = {
    requestAccessToken: (overrides?: { prompt?: string }) => void;
  };

  function initTokenClient(options: {
    client_id: string;
    scope: string;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): TokenClient;
}

interface Window {
  google?: typeof google;
}