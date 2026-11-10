import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuth } from './auth';
import { DemoProvider } from './demo';
import AppLayout from './layouts/AppLayout';
import AdminLayout from './layouts/AdminLayout';
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';
import Register from './pages/Register';
import Upload from './pages/user/Upload';
import Courses from './pages/user/Courses';
import CourseDetail from './pages/user/CourseDetail';
import SubmissionDetail from './pages/user/SubmissionDetail';
import Submissions from './pages/user/Submissions';
import Profile from './pages/user/Profile';
import Overview from './pages/user/Overview';
import Supervision from './pages/user/Supervision';
import ViewManagement from './pages/user/ViewManagement';
import Dashboard from './pages/admin/Dashboard';
import Users from './pages/admin/Users';
import Records from './pages/admin/Records';
import Checklists from './pages/admin/Checklists';
import ChecklistEditor from './pages/admin/ChecklistEditor';
import Plans from './pages/admin/Plans';
import AiConfig from './pages/admin/AiConfig';
import SiteSettings from './pages/admin/SiteSettings';
import Logs from './pages/admin/Logs';

function RequireAuth({ children, admin }: { children: React.ReactNode; admin?: boolean }) {
  const { user } = useAuth();
  const loc = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (user.must_change_password) return <Navigate to="/change-password" replace />;
  if (admin && user.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const { loading, user } = useAuth();
  if (loading)
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin />
      </div>
    );
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/change-password" element={!user ? <Navigate to="/login" replace /> : user.must_change_password ? <ChangePassword /> : <Navigate to="/" replace />} />
      <Route path="/register" element={user ? <Navigate to="/" replace /> : <Register />} />
      <Route
        element={
          <RequireAuth>
            <DemoProvider key={user?.id}><AppLayout /></DemoProvider>
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="overview" element={<Overview />} />
        <Route path="supervision" element={<Supervision />} />
        <Route path="view-management" element={user && (user.role === 'admin' || user.supervision_manager) ? <ViewManagement /> : <Navigate to="/" replace />} />
        <Route path="upload" element={<Upload />} />
        <Route path="courses" element={<Courses />} />
        <Route path="courses/:id" element={<CourseDetail />} />
        <Route path="submissions" element={<Submissions />} />
        <Route path="submissions/:id" element={<SubmissionDetail />} />
        <Route path="checklist" element={<Navigate to="/upload" replace />} />
        <Route path="profile" element={<Profile />} />
        <Route
          path="admin"
          element={
            <RequireAuth admin>
              <AdminLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="users" element={<Users />} />
          <Route path="records" element={<Records />} />
          <Route path="checklists" element={<Checklists />} />
          <Route path="checklists/:id" element={<ChecklistEditor />} />
          <Route path="plans" element={<Plans />} />
          <Route path="ai" element={<AiConfig />} />
          <Route path="settings" element={<SiteSettings />} />
          <Route path="logs" element={<Logs />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
