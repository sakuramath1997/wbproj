import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { ProjectDashboard } from './pages/ProjectDashboard';
import { BoardEditor } from './pages/BoardEditor';
import { useProjectStore } from './hooks/useProjectStore';

export default function App() {
  const { initialize, isInitialized, isLoading } = useProjectStore();

  // アプリ起動時に IndexedDB からデータを復元
  useEffect(() => {
    initialize();
  }, [initialize]);

  // 初期化中はローディング表示
  if (!isInitialized || isLoading) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/project" element={<ProjectDashboard />} />
      <Route path="/project/board/:boardId" element={<BoardEditor />} />
    </Routes>
  );
}
