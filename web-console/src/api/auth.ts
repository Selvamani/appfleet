import { requestRaw, type ApiResponse } from './http';

/**
 * identity-service (port 8082): the endpoints built in steps I2 to I4. In hybrid mode the dev proxy sends
 * /api/v1/auth to the live service; in mock mode nothing answers them (the sign-in screen says so).
 *
 * These return the whole response, not just the body: the sign-in screen shows every call with its status and
 * correlation id, so the status is part of what it needs.
 */

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  /** Seconds the access token lives. */
  expiresIn: number;
  refreshToken: string;
}

export interface RegisteredUser {
  id: string;
  email: string;
  displayName: string;
}

export interface RegisterRequest {
  email: string;
  displayName: string;
  password: string;
}

export const register = (body: RegisterRequest): Promise<ApiResponse<RegisteredUser>> =>
  requestRaw<RegisteredUser>('/api/v1/auth/register', { method: 'POST', body, anonymous: true });

export const login = (email: string, password: string): Promise<ApiResponse<TokenResponse>> =>
  requestRaw<TokenResponse>('/api/v1/auth/login', { method: 'POST', body: { email, password }, anonymous: true });

/** Uses the refresh token up and returns the next pair. A token that was already used revokes the whole family. */
export const refreshSession = (refreshToken: string): Promise<ApiResponse<TokenResponse>> =>
  requestRaw<TokenResponse>('/api/v1/auth/refresh', { method: 'POST', body: { refreshToken }, anonymous: true });

/** 204 whether or not the token was known. */
export const logout = (refreshToken: string): Promise<ApiResponse<void>> =>
  requestRaw<void>('/api/v1/auth/logout', { method: 'POST', body: { refreshToken }, anonymous: true });