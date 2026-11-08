export type Role = 'admin' | 'user';
export type UserStatus = 'pending' | 'active' | 'disabled';
export type Section = 'main' | 'matrix' | 'suggest';

export interface User {
  id: number;
  username: string;
  roster_login: number;
  name: string;
  department: string;
  role: Role;
  college_role: 'none' | 'teaching' | 'program';
  led_groups: string[];
  program_scopes: string[];
  supervision_manager: number;
  must_change_password: number;
  status: UserStatus;
  created_at: string;
  last_login_at: string | null;
}

export interface SiteInfo {
  siteName: string;
  registrationMode: 'open' | 'approval' | 'closed';
  hasUsers: boolean;
}

export interface CheckQuota {
  bonus: number;
  limit: number;
  used: number;
  pending: number;
  remaining: number;
}

export interface ChecklistItem {
  code: string;
  section: Section;
  title: string;
  content: string;
}

export interface Checklist {
  id: number;
  name: string;
  intro: string;
  notes: Partial<Record<Section, { before?: string; after?: string }>>;
  rules: string;
  is_active: number;
  items: ChecklistItem[];
}

export type SectionMeta = Record<Section, { title: string; colTitle: string; colContent: string }>;

export type ItemResultValue = '未发现问题' | '存在问题' | '需核实' | '不适用';
export type Nature = '重大问题' | '明确问题' | '建议修改';

export interface CheckResult {
  summary: string;
  itemResults: { code: string; result: ItemResultValue; note: string }[];
  issues: { nature: Nature; itemCodes: string[]; title: string; location: string; problem: string; advice: string; evidence: string }[];
  toVerify: { itemCodes: string[]; location: string; content: string }[];
}

export type SubStatus = 'queued' | 'running' | 'done' | 'failed';

export interface RequiredCourseProgress {
  id: number;
  course_name: string;
  course_group: string;
  professional: string;
  latest_id: number | null;
  status: SubStatus | null;
  verdict: 'passed' | 'failed' | null;
  confirmed_at: string | null;
  confirmed_by: string;
  created_at: string | null;
}

export interface PersonalProgress {
  configured: boolean;
  required: number;
  uploaded: number;
  passed: number;
  confirmed: number;
  courses: RequiredCourseProgress[];
}

export interface CourseInfo {
  name: string;
  major: string;
  trainingType: string;
  studentGrade: number;
  planGrade: number;
  adjustNote: string;
}

export interface SubmissionDetail {
  id: number;
  course_id: number;
  user_id: number;
  seq: number;
  file_name: string;
  file_size: number;
  extracted_text: string;
  checklist_version_id: number | null;
  plan_id: number | null;
  plan_name: string | null;
  ai_model: string | null;
  status: SubStatus;
  error: string | null;
  verdict: 'passed' | 'failed' | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  confirmed_at: string | null;
  confirmed_by: string;
  canConfirm: boolean;
  course: CourseInfo;
  result: CheckResult | null;
  queuePosition: number | null;
  owner: { username: string; name: string };
}

export interface CourseRow {
  id: number;
  user_id: number;
  name: string;
  major: string;
  training_type: string;
  student_grade: number;
  plan_grade: number;
  adjust_note: string;
  created_at: string;
  username: string;
  user_name: string;
  submission_count: number;
  latest_id: number | null;
  latest_status: SubStatus | null;
  latest_verdict: 'passed' | 'failed' | null;
  latest_at: string | null;
  latest_confirmed_at: string | null;
}

export interface SubmissionRow {
  id: number;
  seq: number;
  course_id: number;
  file_name: string;
  file_size: number;
  status: SubStatus;
  verdict: 'passed' | 'failed' | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  confirmed_at: string | null;
  course_name: string;
  major: string;
  training_type: string;
  student_grade: number;
}

export interface Options {
  requiredCourses: { name: string; professional: string }[];
  majors: string[];
  studentGrades: number[];
  plans: { major: string; training_type: string; grade: number; name: string }[];
  trainingTypes: string[];
  maxUploadMB: number;
  aiReady: boolean;
  checklist: { id: number; name: string } | null;
}
