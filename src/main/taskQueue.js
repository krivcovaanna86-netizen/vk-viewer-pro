/**
 * TaskQueue v1.0 — VK Video Engagement
 *
 * Manages engagement tasks: views, likes, comments
 * Parallel execution with abort support
 */

const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

class TaskQueue extends EventEmitter {
  constructor(store, playwrightEngine) {
    super();
    this.store = store;
    this.engine = playwrightEngine;
    this.abortControllers = new Map();
    this.runningTasks = new Set();
  }

  getAll() { return this.store.get('tasks', []); }

  create(task) {
    const tasks = this.getAll();
    const viewCount = Math.max(task.viewCount || 0, 0);
    const likeCount = Math.min(Math.max(task.likeCount || 0, 0), viewCount || Infinity);
    const commentCount = Math.min(Math.max(task.commentCount || 0, 0), viewCount || Infinity);

    const newTask = {
      id: uuidv4(),
      videoUrl: task.videoUrl || '',
      videoTitle: task.videoTitle || null,
      searchKeywords: task.searchKeywords || '',
      useSearch: !!task.useSearch,
      viewCount,
      likeCount,
      commentCount,
      accountIds: task.accountIds || [],
      proxyIds: task.proxyIds || [],
      allowDirect: !!task.allowDirect,
      commentFolderId: task.commentFolderId || null,
      type: 'engagement',
      status: 'pending',
      progress: 0,
      totalItems: viewCount,
      completedItems: 0,
      successItems: 0,
      errorItems: 0,
      results: [],
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };
    tasks.push(newTask);
    this.store.set('tasks', tasks);
    return newTask;
  }

  remove(id) {
    this.stop(id);
    this.store.set('tasks', this.getAll().filter(t => t.id !== id));
    return true;
  }

  async start(id) {
    const task = this.getAll().find(t => t.id === id);
    if (!task) return { success: false, error: 'Task not found' };
    if (task.status === 'running') return { success: false, error: 'Already running' };

    this.updateTask(id, {
      status: 'running', startedAt: new Date().toISOString(),
      progress: 0, completedItems: 0, successItems: 0, errorItems: 0, results: [],
    });

    const controller = new AbortController();
    this.abortControllers.set(id, controller);
    this.runningTasks.add(id);

    const onProgress = (data) => {
      const pct = Math.round(((data.current || 0) / (data.total || 1)) * 100);
      this.updateTask(id, { progress: pct, completedItems: data.current || 0 });
      this.emit('taskProgress', { taskId: id, ...data, progress: pct });
      this.emit('taskLog', {
        level: data.status === 'error' ? 'error' : 'info',
        message: `[Task] Op ${data.current}/${data.total} — ${data.message || data.status}`,
      });
    };

    this._executeTask(id, task, onProgress, controller.signal);
    return { success: true };
  }

  async _executeTask(id, task, onProgress, signal) {
    try {
      const results = await this.engine.executeEngagementTask(task, onProgress, signal);
      const status = signal.aborted ? 'stopped' : 'completed';

      // results is { views, likes, comments, errors } — not an array
      const successCount = (results.views || 0) + (results.likes || 0) + (results.comments || 0);
      const errorCount = results.errors || 0;

      this.updateTask(id, {
        status, results,
        completedAt: new Date().toISOString(),
        progress: signal.aborted ? undefined : 100,
        completedItems: (results.views || 0),
        successItems: successCount,
        errorItems: errorCount,
      });
      this.emit('taskLog', {
        level: status === 'completed' ? 'success' : 'warn',
        message: `Task ${id.substring(0, 8)}: ${status} (views: ${results.views || 0}, likes: ${results.likes || 0}, comments: ${results.comments || 0}, errors: ${errorCount})`,
      });
    } catch (e) {
      this.updateTask(id, { status: 'error', completedAt: new Date().toISOString(), results: { error: e.message } });
      this.emit('taskLog', { level: 'error', message: `Task ${id.substring(0, 8)} error: ${e.message}` });
    } finally {
      this.abortControllers.delete(id);
      this.runningTasks.delete(id);
    }
  }

  stop(id) {
    const controller = this.abortControllers.get(id);
    if (controller) { controller.abort(); this.abortControllers.delete(id); }
    this.runningTasks.delete(id);
    this.engine.cleanup();
    this.updateTask(id, { status: 'stopped', completedAt: new Date().toISOString() });
    return true;
  }

  async startAll() {
    const tasks = this.getAll().filter(t => ['pending', 'stopped', 'error'].includes(t.status));
    let started = 0;
    for (const task of tasks) {
      const r = await this.start(task.id);
      if (r.success) started++;
    }
    return { started };
  }

  stopAll() {
    for (const id of [...this.abortControllers.keys()]) this.stop(id);
    return true;
  }

  updateTask(id, updates) {
    this.store.set('tasks', this.getAll().map(t => t.id === id ? { ...t, ...updates } : t));
  }

  getRunningCount() { return this.runningTasks.size; }
  isRunning(id) { return this.runningTasks.has(id); }
}

module.exports = { TaskQueue };
