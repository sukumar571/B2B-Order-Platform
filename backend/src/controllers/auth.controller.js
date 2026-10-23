'use strict';

const config = require('../config/env');
const authService = require('../services/auth.service');
const { asyncHandler } = require('../middleware/asyncHandler');

/**
 * HTTP layer for authentication. Cookie strategy (docs/decision-log.md D-19):
 * the refresh-token envelope travels ONLY in an HttpOnly, SameSite=strict
 * cookie scoped to /api/auth — JavaScript (and therefore XSS) can never read
 * it, and SameSite=strict means a third-party site cannot even send it, which
 * removes the CSRF exposure a cookie refresh endpoint would otherwise have.
 * Access tokens are returned in the JSON body for in-memory Bearer use.
 */

const REFRESH_COOKIE = 'refresh_token';
const COOKIE_PATH = '/api/auth';

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure, // must be true outside dev/test (HTTPS)
    path: COOKIE_PATH,
    maxAge: maxAgeMs,
  };
}

function setRefreshCookie(res, envelope) {
  res.cookie(REFRESH_COOKIE, envelope, cookieOptions(authService.ttlMs(config.jwtRefreshTtl)));
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(undefined), path: COOKIE_PATH });
}

/** POST /api/auth/register — 201 for customers only. */
const register = asyncHandler(async (req, res) => {
  const { user, accessToken, refreshToken } = await authService.register(req.body);
  setRefreshCookie(res, refreshToken);
  res.status(201).json({ message: 'Account created', user, accessToken });
});

/** POST /api/auth/login — 200, or the generic 401/403 from the service. */
const login = asyncHandler(async (req, res) => {
  const { user, accessToken, refreshToken } = await authService.login(req.body);
  setRefreshCookie(res, refreshToken);
  res.status(200).json({ message: 'Login successful', user, accessToken });
});

/** POST /api/auth/refresh — rotates the refresh cookie + new access token. */
const refresh = asyncHandler(async (req, res) => {
  const { user, accessToken, refreshToken } = await authService.refresh(
    req.cookies ? req.cookies[REFRESH_COOKIE] : undefined
  );
  setRefreshCookie(res, refreshToken);
  res.status(200).json({ message: 'Token refreshed', user, accessToken });
});

/** POST /api/auth/logout — revokes the token family and clears the cookie. */
const logout = asyncHandler(async (req, res) => {
  const result = await authService.logout(req.cookies ? req.cookies[REFRESH_COOKIE] : undefined);
  clearRefreshCookie(res);
  res.status(200).json(result);
});

/** GET /api/auth/me — identity strictly from the Bearer token (req.user). */
const me = asyncHandler(async (req, res) => {
  res.status(200).json({ user: req.user });
});

module.exports = { register, login, refresh, logout, me, REFRESH_COOKIE, COOKIE_PATH };
