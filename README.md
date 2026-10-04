# 昆虫标本采集记录台（gbinsectlog）

面向野外昆虫调查队与标本馆技术员，把「标本采集 → 采集地与生境 → 鉴定状态 → 保藏位置」串成一条可追溯的编目链路，解决采集标签手写易错、鉴定进度无人跟踪、标本入柜后找不到位置的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21815>

常用命令：

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地，不受影响）
```

端口与项目名可在 `.env` 中调整：

```
COMPOSE_PROJECT_NAME=gbinsectlog
FRONTEND_PORT=21815
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 |
| 语言 | TypeScript（`tsc --noEmit` 类型检查零错误） |
| 样式 | Tailwind CSS 3 |
| 状态管理 | Zustand |
| 路由 | React Router 6（nginx `try_files` 回落，支持直接刷新子路由） |
| 构建 | Vite 5 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21815
npm run build      # 类型检查 + 生产构建
```

> 本地开发无需任何后端服务或环境变量。

## 四、目录结构

```
sologsb-1115/
├── docker-compose.yml          # 顶层 name: gbinsectlog，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── tailwind.config.js / postcss.config.js
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # specimen.ts / site.ts / storage.ts / determination.ts / index.ts
│       ├── stores/             # specimenStore / siteStore / storageStore / determinationStore（Zustand）
│       ├── components/common/  # SpecimenCard / StatusTag / CabinetGrid / SitePicker
│       ├── hooks/              # usePersistentStore / useSpecimenFilter
│       ├── pages/              # SpecimensPage / SitesPage / CollectPage / DeterminationPage / StoragePage / MergePage
│       ├── router/index.tsx
│       └── utils/              # codec.ts / export.ts / id.ts / merge.ts（交接包三方合并引擎）
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Specimen 标本 | 编号、目/科/属/种、暂定名、采集日期与人、性别虫态、体长、采集方式、数量、鉴定状态 | `specimens` |
| CollectSite 采集地 | 代码、名称、行政区、经纬度海拔、生境类型、小生境、微气候、采集日期区间 | `sites` |
| Storage 保藏位置 | 保藏方式、柜/抽屉/盒/插位序号、入柜日期、经手人 | `storages` |
| Determination 鉴定记录 | 鉴定人、日期、结论（学名）、依据文献、置信度、是否需复核 | `determinations` |

- 数据库名 `gbinsectlog`，`meta` 表保存 `schemaVersion`（当前 v3）；
- `version(2)` 升级迁移会为历史标本补齐默认采集方式（扫网）；
- `version(3)` 新增 `mergeJobs`（离线交接合并任务，失败可恢复重试）与 `baselines`（野外机保存的出队基线）两张表，业务表结构不变；
- 标本编号规则：`采集地代码-年份-流水号`（如 `QLB-2026-0007`），提交时自动分配并查重；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/specimens` | 标本清单：按目/科、鉴定状态、采集地、采集日期区间与关键字组合筛选，多选批量推进鉴定状态，导出命中清单 |
| `/collect` | 采集登记：选择采集地后自动带出生境/小生境/微气候，一次提交多条同批次标本，编号自动生成并查重 |
| `/sites` | 采集地管理：经纬度格式校验、各地采集次数统计、50 米内邻近采集地提示与一键合并 |
| `/determination` | 鉴定工作流：待鉴定队列逐条处理，落鉴定记录并自动推进标本状态（已鉴定 / 待复核） |
| `/storage` | 保藏柜位图：柜-抽屉-盒-位三级展开，空位/占用一目了然，拖拽入柜，重复占用给出占用提示 |
| `/merge` | 离线交接包：野外机导入馆内基线后离线录入，回馆导出交接包，按基线三方合并，冲突列对照，写库失败可重试 |

## 六之二、离线交接包合并规则

野外队把采集地、标本、鉴定记录、保藏位置导成一个 JSON 交接包，回馆后在 `/merge` 页面合并进现有台账：

1. **交接包与基线**：馆内先做「全量备份」，野外机通过「导入馆内基线」读入后离线录入；导出交接包时自动把基线内嵌进包里。基线就是普通全量备份，旧版备份文件也能当基线用。
2. **采集地认定**：按采集地代码（大小写不敏感）相同 **或** 坐标 50 米内认到同一处；两个条件各命中不同记录时列为歧义，人工选择认到既有记录或新建。本馆代码始终保留，不会被包里的代码改写。
3. **标本编号照旧**：标本按编号（采集地代码-年份-流水号）认定，箱签与历史编号原样保留，不重新分配、不加后缀；采集地改挂只改标本的 `siteId`。
4. **三方字段合并**（本馆现值 / 野外值 / 出队基线）：
   - 只有野外改了 → 直接接野外值；只有本馆改了 → 保持本馆值；
   - 两边都改成不同值 → 列出三个来源的值对照，人工「取本馆 / 取野外」，默认保持本馆；
   - 没有基线的旧备份：凡双方不一致一律先列对照，不静默覆盖。
5. **保藏位置闸门**：同一标本存在未处理的字段对照时，其保藏位置在处理完成前不写库；入柜前再核柜位占用，同一柜位不会出现两份标本。
6. **失败可恢复、重试幂等**：合并任务持久化在 `mergeJobs` 表（含整包与已做的处理选择），刷新或写库失败后可原样打开重试；全部写入在单个 Dexie 事务内，新增行使用由自然键推导的确定性 id + `put`，重试不会重复建档或占两个柜位。任务可多次执行，每次只写剩余差异。
7. **旧备份兼容**：旧版全量备份（顶层平铺数组、无 `baseline`）可直接在同一入口导入，按第 4 条的无基线策略合并。

## 七、业务约定

- 采集地代码是标本编号前缀，代码重复会被拒绝；
- 坐标 50 米内视为同一采集地，页面上给出合并提示，合并会把原采集地标本自动改挂；
- 鉴定记录提交后自动把标本状态推进为「已鉴定」，勾选「需复核」则置为「待复核」；
- 同一柜位（柜-屉-盒-位）只允许一份标本，冲突时列出已有标本编号。
