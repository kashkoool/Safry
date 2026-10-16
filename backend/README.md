# Safry Backend

النواة الأولى لمنصة سفري مبنية كـ Modular Monolith باستخدام NestJS وPostgreSQL وPrisma. يبدأ التنفيذ من نطاق الهوية وإدارة الوصول لأن جميع نطاقات المنصة تعتمد على المستخدم والجهة والصلاحيات والعزل بين الجهات.

## المتطلبات

- Node.js 22 LTS (الحد الأدنى المدعوم 22.12؛ صور Docker تستخدم Node 22)
- pnpm 11 أو أحدث
- PostgreSQL 17، أو قاعدة Prisma Postgres المحلية المرفقة مع Prisma دون Docker
- Docker اختياري فقط عند الرغبة باستخدام PostgreSQL container عبر `compose.yml`

## التشغيل المحلي

1. انسخ `.env.example` إلى `.env` واستبدل كل قيمة `CHANGE_ME` بسر تولّده بنفسك (`openssl rand -base64 48` لـ `JWT_ACCESS_SECRET`، و`openssl rand -base64 18` لكلمتي `BOOTSTRAP_ADMIN_PASSWORD` و`DEMO_SEED_PASSWORD`). لا توجد كلمات مرور افتراضية، ويرفض التشغيل والبذر القيم النموذجية.
2. نفّذ `pnpm db:local` لتشغيل PostgreSQL محلي خفيف دون Docker.
3. نفّذ `pnpm install`.
4. نفّذ `pnpm prisma:generate`.
5. نفّذ `pnpm db:deploy` لتطبيق migrations الموجودة.
6. اختيارياً، نفّذ `pnpm db:seed` لإنشاء الجهة والمستخدم الإداري الأول وبيانات تجريبية (يتطلب كلمتي المرور أعلاه، ويرفض `NODE_ENV=production` ما لم يُضبط `ALLOW_DEMO_SEED_IN_PRODUCTION=true`).
7. نفّذ `pnpm start:dev`.

لعرض قواعد البيانات المحلية استخدم `pnpm db:local:list`، ولإيقاف قاعدة Safry استخدم `pnpm db:local:stop`.

توثيق Swagger متاح على `http://localhost:3000/api/v1/docs`، وفحص الجاهزية على `/api/v1/health/ready`.

## المسارات الحالية

تعرّف المتحكمات عدداً من المسارات (يتحقق منها فحص `pnpm test:routes` في CI) موزعة على: الهوية والمصادقة (تسجيل، دخول، تجديد، خروج، MFA مع واجهة ويب لتفعيله والدخول به)، الجهات والأعضاء، الأدوار والصلاحيات، المنشآت والأقسام والموظفين، كتالوج الخدمات وأسعار الصرف، الحجوزات، إدارة المنصة، والصحة. المرجع الدقيق والمحدّث هو Swagger على `/api/v1/docs`.

## English notes

- Stack as declared in `package.json`: NestJS 12, Prisma 7, TypeScript 6, Vitest 5; Node >= 22.12; PostgreSQL 17 in both `backend/compose.yml` and the root `docker-compose.yml`.
- Tests: `pnpm test` (unit tests), `pnpm test:int` (integration tests on a throwaway embedded PostgreSQL with row-level security forced on), `pnpm test:business` (smoke script that needs a running API and database; creates and deletes its own tenants, so point it only at a local database).
- Authentication errors and validation messages are free-text strings (Arabic from services, English from validators); error responses carry a machine-readable `code` field only for a few cases (for example an expired booking or required MFA enrolment); everywhere else the message text is the only signal.

## قواعد المعمارية

- كل سجل أعمال تابع لجهة يجب أن يحمل `tenantId` ويُفلتر به في طبقة الوصول للبيانات.
- الهوية العامة للمستخدم منفصلة عن عضويته وأدواره في كل جهة.
- لا تُستعمل جداول التدقيق كجزء من منطق الأعمال؛ هي سجل طرفي للأحداث.
- الوحدات الجديدة تُضاف تحت `src/modules` بحسب نطاق المنتج، مع منع الاستيراد المباشر العشوائي بين الوحدات.
- استخراج microservice يتم فقط عند وجود سبب تشغيلي واضح مثل حمل مستقل أو ملكية فريق منفصلة أو حدود تكامل حساسة.
