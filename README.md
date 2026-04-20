# Surface Tension Browser Lab

一个纯静态部署的网页版实验数据处理工具，保留原项目的数据分析核心，但把运行环境迁移到了浏览器本地。

## 目标达成方式

- 前端：`HTML + CSS + JavaScript`
- Python 运行方式：`Pyodide` 在浏览器内执行
- 文件处理方式：用户本地选择文件后，先写入浏览器内存文件系统，再由 Python 读取
- 部署方式：可直接部署到 `GitHub Pages`、`Netlify`、`Cloudflare Pages`
- 后端依赖：无 Flask / Django / FastAPI / Node 文件处理接口

## 目录结构

```text
web-static-pyodide/
├─ index.html
├─ assets/
│  ├─ css/main.css
│  └─ js/
│     ├─ app.js
│     ├─ charts.js
│     ├─ config.js
│     ├─ downloads.js
│     └─ pyodide-client.js
├─ py/
│  ├─ web_bridge.py
│  └─ DataProcessor/
│     ├─ services/
│     └─ utils/
└─ tests/
   └─ test_web_bridge.py
```

## 职责拆分

### Python in browser

- CSV 编码检测与稳健读取
- FAMAS 多实验 CSV 归一化
- 行范围与实验范围解析
- CMC 液滴均值/标准差计算
- CSV 到 XLSX 导出
- 文件名浓度推断

### JavaScript

- 本地文件选择
- 将文件写入 Pyodide 的内存文件系统
- 调用 Python 桥接层
- 使用 Plotly 渲染图表
- 本地下载 XLSX / PNG

## 运行方式

直接用任意静态文件服务器启动即可，例如在仓库根目录执行：

```bash
python3 -m http.server 8080
```

然后访问：

```text
http://localhost:8080/web-static-pyodide/
```

不要直接双击 `index.html` 用 `file://` 打开，因为浏览器通常会限制模块和资源加载。

## 部署说明

### GitHub Pages

- 将 `web-static-pyodide/` 作为发布目录
- 确保静态资源按原路径保留

### Netlify

- Publish directory 指向 `web-static-pyodide`

### Cloudflare Pages

- Build command 留空
- Output directory 指向 `web-static-pyodide`

## 运行时依赖

- `Pyodide 0.29.3`
- `numpy`
- `pandas`
- `micropip`
- `openpyxl`
- `chardet`
- `xlrd`
- `Plotly`

其中 Pyodide 和 Plotly 在浏览器启动时从 CDN 拉取。Python 分析代码来自当前项目中已有的服务层逻辑复制件，新 Web 目录不依赖原桌面 UI。
