import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { auth, functions } from './firebase'
import Play from './pages/Play'
import InstructorDashboard from './pages/InstructorDashboard'
import Configure from './pages/Configure'
import Reports from './pages/Reports'
import { SettingsPage } from '@mygames/game-ui'

const ebayRoleLabels: Record<string, string> = {
  expert:    'Expert',
  nonexpert: 'Non-Expert',
}

const ebayInfoLinks = [
  { roleKey: 'expert', links: [
    { key: 'expert_sheet_url', label: 'Role sheet' },
  ]},
  { roleKey: 'nonexpert', links: [
    { key: 'nonexpert_sheet_url', label: 'Role sheet' },
  ]},
]

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"          element={<Play />} />
        <Route path="/dashboard" element={<InstructorDashboard />} />
        <Route path="/configure" element={<Configure />} />
        <Route path="/reports"   element={<Reports />} />
        <Route path="/settings"  element={
          <SettingsPage
            title="Settings — eBay"
            functions={functions}
            auth={auth}
            roleLabels={ebayRoleLabels}
            roleInfoLinks={ebayInfoLinks}
          />
        } />
      </Routes>
    </BrowserRouter>
  )
}
