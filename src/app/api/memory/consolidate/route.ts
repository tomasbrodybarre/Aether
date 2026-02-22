import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { project } = body;

    if (!project) {
      return NextResponse.json({ error: 'Project name is required' }, { status: 400 });
    }

    const projectDir = path.resolve('C:/agent-hub/projects', project);
    const scriptPath = 'C:/agent-hub/skills/memory/consolidate_memory.py';

    const pythonProcess = spawn('python', [scriptPath, '--project', projectDir]);

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    return new Promise<NextResponse>((resolve) => {
      pythonProcess.on('close', (code) => {
        if (code === 0) {
          resolve(NextResponse.json({ success: true, stdout, stderr }));
        } else {
          resolve(NextResponse.json({ success: false, error: 'Script execution failed', stdout, stderr, code }, { status: 500 }));
        }
      });

      pythonProcess.on('error', (err) => {
        resolve(NextResponse.json({ success: false, error: 'Failed to start script', details: err.message }, { status: 500 }));
      });
    });

  } catch (error) {
    let errorMessage = 'An unknown error occurred';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    return NextResponse.json({ error: 'Failed to process request', details: errorMessage }, { status: 500 });
  }
}
