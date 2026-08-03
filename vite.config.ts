import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({plugins:[react()],test:{environment:'jsdom',globals:true,include:['src/**/*.{test,spec}.{ts,tsx}'],env:{VITE_SUPABASE_URL:'',VITE_SUPABASE_ANON_KEY:'',VITE_MAP_PROVIDER:'mock'}}})
