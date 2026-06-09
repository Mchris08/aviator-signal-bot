import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://ouritbblsqnmwmvbrgwm.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91cml0YmJsc3FubXdtdmJyZ3dtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MDg3NjcsImV4cCI6MjA5NjQ4NDc2N30.pPlPqdGCJWpOIYweh9Lg2INwLprjcl-IxPkAfGpD8uM'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Hash password using Web Crypto API
const SALT = 'avb_signal_bot_2025'
export async function hashPassword(password) {
  const encoder = new TextEncoder()
  const data = encoder.encode(password + SALT)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

// Register new account
export async function registerAccount({ name, phone, password, key }) {
  const hashed = await hashPassword(password)
  const { data, error } = await supabase
    .from('Accounts')
    .insert([{ 
      name, 
      phone, 
      password: hashed, 
      key: key || 'AVBOT2025',
      active: true,
      joined: new Date().toISOString().slice(0, 10)
    }])
    .select()
    .single()
  return { data, error }
}

// Login
export async function loginAccount({ phone, password }) {
  const hashed = await hashPassword(password)
  const { data, error } = await supabase
    .from('Accounts')
    .select('*')
    .eq('phone', phone)
    .eq('password', hashed)
    .single()
  return { data, error }
}

// Fetch all accounts (admin)
export async function fetchAllAccounts() {
  const { data, error } = await supabase
    .from('Accounts')
    .select('*')
    .order('id', { ascending: false })
  return { data: data || [], error }
}

// Update account (admin)
export async function updateAccount(id, updates) {
  const { data, error } = await supabase
    .from('Accounts')
    .update(updates)
    .eq('id', id)
    .select()
    .single()
  return { data, error }
}

// Delete account (admin)
export async function deleteAccount(id) {
  const { error } = await supabase
    .from('Accounts')
    .delete()
    .eq('id', id)
  return { error }
}

// Fetch access keys (admin)
export async function fetchKeys() {
  const { data, error } = await supabase
    .from('access_keys')
    .select('*')
    .order('id', { ascending: false })
  return { data: data || [], error }
}

// Add access key (admin)
export async function addKey(key) {
  const { data, error } = await supabase
    .from('access_keys')
    .insert([{ key }])
    .select()
    .single()
  return { data, error }
}

// Remove access key (admin)
export async function removeKey(key) {
  const { error } = await supabase
    .from('access_keys')
    .delete()
    .eq('key', key)
  return { error }
}

// Validate access key exists
export async function validateKey(key) {
  if (!key) return true // allow empty key for demo
  const { data } = await supabase
    .from('access_keys')
    .select('key')
    .eq('key', key)
    .single()
  return !!data
}
