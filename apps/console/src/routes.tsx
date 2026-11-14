import { Route, Routes } from 'react-router';
import { LoginPage, RequireAuth } from './auth';
import { Layout } from './Layout';
import { AgentDetailPage, AgentsPage } from './pages/Agents';
import { ApprovalsPage } from './pages/Approvals';
import { BillingPage } from './pages/Billing';
import { ConversationPage } from './pages/Conversation';
import { DashboardPage } from './pages/Dashboard';
import { MarketplacePage } from './pages/Marketplace';
import { McpDetailPage, McpListPage } from './pages/Mcp';
import { McpWizardPage } from './pages/McpWizard';
import { MemoryPage } from './pages/Memory';
import { SkillDetailPage, SkillsPage } from './pages/Skills';
import { TaskDetailPage } from './pages/TaskDetail';
import { TasksPage } from './pages/Tasks';
import { WidgetSettingsPage } from './pages/WidgetSettings';
import { WorkspacePage } from './pages/Workspace';
import { Empty, PageHeader } from './ui';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="tasks/:id" element={<TaskDetailPage />} />
        <Route path="conversations/:id" element={<ConversationPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:id" element={<AgentDetailPage />} />
        <Route path="mcp" element={<McpListPage />} />
        <Route path="mcp/new" element={<McpWizardPage />} />
        <Route path="mcp/:id" element={<McpDetailPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="skills/:id" element={<SkillDetailPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="widget" element={<WidgetSettingsPage />} />
        <Route path="marketplace" element={<MarketplacePage />} />
        <Route path="billing" element={<BillingPage />} />
        <Route path="workspace" element={<WorkspacePage />} />
        <Route
          path="*"
          element={
            <>
              <PageHeader title="페이지를 찾을 수 없어요" />
              <Empty title="주소를 확인해 주세요." />
            </>
          }
        />
      </Route>
    </Routes>
  );
}
