import { z } from 'zod';

export const sessionSummaryInput = z.strictObject({
  session_ids: z.array(z.string().min(1).max(200)).min(1).max(100)
    .refine(ids => new Set(ids).size === ids.length, 'Session IDs must be unique'),
});

// One bounded query, no native session reads and no per-row Task detail reads.
export function readSessionSummaries(db, input) {
  const rows = db.prepare(`
    WITH requested AS MATERIALIZED (SELECT value AS session_id, key AS ordinal FROM json_each(?)),
    bindings AS (
      SELECT t.assignee, count(*) AS total,
        max(CASE WHEN t.status NOT IN ('done','cancelled') THEN t.id END) AS current_id
      FROM tasks t JOIN requested r ON r.session_id=t.assignee
      WHERE t.kind='agent' GROUP BY t.assignee
    ),
    selected AS (
      SELECT r.*, b.total, b.current_id,
        coalesce(b.current_id, (
          SELECT a.task_id FROM task_assignments a
          JOIN tasks t ON t.id=a.task_id AND t.assignee=a.assignee AND t.kind='agent'
          WHERE a.assignee=r.session_id ORDER BY a.seq DESC LIMIT 1
        )) AS task_id
      FROM requested r LEFT JOIN bindings b ON b.assignee=r.session_id
    )
    SELECT s.session_id, s.total, s.current_id, t.id, t.title, t.status, t.parent_task_id,
      EXISTS(SELECT 1 FROM tasks child WHERE child.parent_task_id=t.id) AS has_children
    FROM selected s LEFT JOIN tasks t ON t.id=s.task_id ORDER BY s.ordinal
  `).all(JSON.stringify(input.session_ids));
  return { items: rows.map(row => ({
    session_id: row.session_id,
    selection: row.current_id ? 'current' : row.id ? 'recent' : row.total ? 'unknown' : 'none',
    task: row.id ? {
      id: row.id, title: row.title, status: row.status,
      position: row.parent_task_id === null ? 'Root' : row.has_children ? 'Branch' : 'Leaf',
    } : null,
  })) };
}
