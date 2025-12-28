import { apiGet, apiPatch } from '../../../api/http'
import type { AuthTenant, AuthUser } from '../../../lib/authContext'

export type ProfileResponse = {
  user: AuthUser
  tenant: AuthTenant
  role?: string
}

export type ProfileUpdatePayload = {
  email?: string
  fullName?: string
}

export async function getProfile(): Promise<ProfileResponse> {
  return apiGet<ProfileResponse>('/auth/me')
}

export async function updateProfile(payload: ProfileUpdatePayload): Promise<ProfileResponse> {
  return apiPatch<ProfileResponse>('/auth/me', payload)
}
