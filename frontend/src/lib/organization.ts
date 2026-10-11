import { request } from "./api";

const seg = encodeURIComponent;

export interface Department {
  id: string;
  code: string;
  name: string;
  active: boolean;
  _count: { members: number };
}
export interface Employee {
  id: string;
  jobTitle: string | null;
  status: "ACTIVE" | "SUSPENDED" | "INVITED" | "REVOKED";
  departmentId: string | null;
  permissionOverrides: Record<string, boolean>;
  user: { id: string; displayName: string; email: string; status: string };
  roles: Array<{ role: { id: string; code: string; name: string } }>;
}
export interface OrganizationManagement {
  organization: { id: string; name: string; type: string; specialties: string[] };
  departments: Department[];
  employees: Employee[];
  assignableRoles: Array<{ id: string; code: string; name: string }>;
  organizationRoles: Array<{ id: string; code: string; name: string; permissions: string[] }>;
}
export interface EmployeeInput {
  email: string;
  displayName: string;
  password: string;
  jobTitle: string;
  departmentId: string;
  roleIds: string[];
  permissionOverrides: Record<string, boolean>;
}
export const organizationApi = {
  overview: (id: string) => request<OrganizationManagement>(`/organizations/${seg(id)}/management`),
  specialties: (id: string, specialties: string[]) =>
    request(`/organizations/${seg(id)}/specialties`, { method: "PATCH", body: JSON.stringify({ specialties }) }),
  createDepartment: (id: string, input: { code: string; name: string }) =>
    request(`/organizations/${seg(id)}/departments`, { method: "POST", body: JSON.stringify(input) }),
  updateDepartment: (id: string, departmentId: string, input: { name?: string; active?: boolean }) =>
    request(`/organizations/${seg(id)}/departments/${seg(departmentId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  createRole: (id: string, input: { code: string; name: string; permissions: string[] }) =>
    request(`/organizations/${seg(id)}/roles`, { method: "POST", body: JSON.stringify(input) }),
  updateRole: (id: string, roleId: string, input: { name: string; permissions: string[] }) =>
    request(`/organizations/${seg(id)}/roles/${seg(roleId)}`, { method: "PATCH", body: JSON.stringify(input) }),
  createEmployee: (id: string, input: EmployeeInput) =>
    request(`/organizations/${seg(id)}/employees`, { method: "POST", body: JSON.stringify(input) }),
  updateEmployee: (id: string, membershipId: string, input: Partial<Omit<EmployeeInput, "email" | "displayName" | "password">> & { status?: "ACTIVE" | "SUSPENDED" | "REVOKED" }) =>
    request(`/organizations/${seg(id)}/employees/${seg(membershipId)}`, { method: "PATCH", body: JSON.stringify(input) })
};
