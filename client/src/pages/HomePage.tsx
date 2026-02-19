import { useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjectStore } from '../hooks/useProjectStore';

export function HomePage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { createNew, loadFromFile } = useProjectStore();

  const handleNewProject = useCallback(async () => {
    await createNew('Untitled Project');
    navigate('/project');
  }, [createNew, navigate]);

  const handleOpenFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      await loadFromFile(file);
      navigate('/project');
    } catch (error) {
      console.error('Failed to load file:', error);
      alert('Failed to load file. Please check the file format.');
    }

    // Reset input
    e.target.value = '';
  }, [loadFromFile, navigate]);

  return (
    <div className="home-page">
      <div className="home-logo">📋</div>
      <h1 className="home-title">Whiteboard Project</h1>
      <p className="home-subtitle">Create and collaborate on whiteboards</p>

      <div className="home-actions">
        <button className="home-btn primary" onClick={handleNewProject}>
          <span className="home-btn-icon">✨</span>
          New Project
        </button>

        <button className="home-btn secondary" onClick={handleOpenFile}>
          <span className="home-btn-icon">📂</span>
          Open File
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".wbproj,.wbelx,.wbel,.snapshot.wbelx"
          onChange={handleFileChange}
          className="hidden-input"
        />
      </div>
    </div>
  );
}
