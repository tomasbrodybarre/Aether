import { NextResponse } from 'next/server';
import { getSetting } from '@/lib/db';
import fs from 'fs';
import path from 'path';

/**
 * GET /api/memory — returns memory system status
 * - observation counts per project file
 * - whether consolidation threshold is reached for any project
 */
export async function GET() {
  try {
    const memoryRepoPath = getSetting('memory_repo_path');
    const threshold = parseInt(getSetting('memory_consolidation_threshold') || '15', 10);

    if (!memoryRepoPath || !fs.existsSync(memoryRepoPath)) {
      return NextResponse.json({ enabled: false, projects: [] });
    }

    const projectsDir = path.join(memoryRepoPath, 'projects');
    const projects: Array<{
      name: string;
      file: string;
      observation_count: number;
      needs_consolidation: boolean;
    }> = [];

    if (fs.existsSync(projectsDir)) {
      const files = fs.readdirSync(projectsDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = path.join(projectsDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        // Count observation-like bullet points: lines starting with "- " after
        // a section that looks like observations/learnings/staged
        // Simple heuristic: count all bullet points in the file
        const bulletLines = content.split('\n').filter(line => /^- /.test(line.trim()));
        const name = file.replace(/\.md$/, '');
        projects.push({
          name,
          file: filePath,
          observation_count: bulletLines.length,
          needs_consolidation: bulletLines.length >= threshold,
        });
      }
    }

    // Check environments dir too
    const envsDir = path.join(memoryRepoPath, 'environments');
    const environments: Array<{
      name: string;
      file: string;
      observation_count: number;
    }> = [];

    if (fs.existsSync(envsDir)) {
      const files = fs.readdirSync(envsDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = path.join(envsDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const bulletLines = content.split('\n').filter(line => /^- /.test(line.trim()));
        environments.push({
          name: file.replace(/\.md$/, ''),
          file: filePath,
          observation_count: bulletLines.length,
        });
      }
    }

    const needsConsolidation = projects.filter(p => p.needs_consolidation);

    return NextResponse.json({
      enabled: true,
      threshold,
      projects,
      environments,
      needs_consolidation: needsConsolidation.length > 0,
      consolidation_candidates: needsConsolidation.map(p => p.name),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read memory status';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
