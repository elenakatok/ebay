import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { auth, functions } from './firebase'
import Play from './pages/Play'
import InstructorDashboard from './pages/InstructorDashboard'
import Configure from './pages/Configure'
import Reports from './pages/Reports'
import { SettingsPage } from '@mygames/game-ui'

const ebayRoleLabels: Record<string, string> = {
  bidder: 'Bidder',
}

const ebayInfoLinks = [
  { roleKey: 'bidder', links: [
    { key: 'bidder_sheet_url', label: 'Role sheet' },
  ]},
]

// Live-auction settings (Slice 3): instructor-editable duration + increment, read by
// startAuction at start time. Rendered as a custom Settings section (the built-in
// sections only cover role names / reservation prices / info links).
const ebayConfigSections = [
  {
    id: 'auction',
    title: 'Auction',
    fields: [
      { key: 'duration_seconds', label: 'Auction duration (seconds)', kind: 'positiveInt' as const, placeholder: '600' },
      { key: 'bid_increment',    label: 'Bid increment',              kind: 'positiveInt' as const, placeholder: '1' },
    ],
  },
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
            configSections={ebayConfigSections}
          />
        } />
      </Routes>
    </BrowserRouter>
  )
}
