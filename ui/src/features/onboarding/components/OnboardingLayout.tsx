import { Outlet } from 'react-router-dom'

export default function OnboardingLayout() {
  return (
    <div className="min-h-screen bg-slate-25 text-slate-900">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-6 py-10">
        <Outlet />
      </div>
    </div>
  )
}
