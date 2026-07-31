"""
考勤应急语音系统 - 后端服务
纯本地运行，管理本地音频文件的增删改查与播放
"""
import os
import sys
import json
import shutil
import subprocess
import mimetypes
import socket
import threading
from datetime import datetime
from pathlib import Path

from flask import (
    Flask, render_template, request, jsonify,
    send_file, send_from_directory
)
from werkzeug.utils import secure_filename

import webview

app = Flask(__name__)

# 项目根目录
# PyInstaller 打包后使用 exe 所在目录，开发时使用脚本所在目录
if getattr(sys, 'frozen', False):
    BASE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(__file__).parent
AUDIO_DIR = BASE_DIR / "audio"
DATA_DIR = BASE_DIR / "data"
CONFIG_FILE = DATA_DIR / "config.json"

# 允许的音频格式
ALLOWED_EXTENSIONS = {"mp3", "wav", "ogg", "flac", "aac", "m4a", "wma"}
# 最大上传文件大小 50MB
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024

# 确保必要目录存在
AUDIO_DIR.mkdir(exist_ok=True)
DATA_DIR.mkdir(exist_ok=True)


def allowed_file(filename: str) -> bool:
    """检查文件扩展名是否允许"""
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def get_audio_files() -> list[dict]:
    """扫描本地音频目录，返回音频文件列表"""
    files = []
    for f in sorted(AUDIO_DIR.iterdir()):
        if f.is_file() and allowed_file(f.name):
            stat = f.stat()
            files.append({
                "name": f.name,
                "size": stat.st_size,
                "size_display": format_size(stat.st_size),
                "modified": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                "ext": f.suffix.lower(),
            })
    return files


def format_size(size_bytes: int) -> str:
    """格式化文件大小显示"""
    for unit in ["B", "KB", "MB", "GB"]:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} TB"


def load_config() -> dict:
    """加载配置文件"""
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                config = json.load(f)
                # 兼容旧配置：补充默认字段
                if "schedule_enabled" not in config:
                    config["schedule_enabled"] = False
                if "output_device_id" not in config:
                    config["output_device_id"] = ""
                for slot in config.get("slots", []):
                    if "time" not in slot:
                        slot["time"] = ""
                return config
        except (json.JSONDecodeError, IOError):
            pass
    return {
        "slots": [{"id": 1, "audio": None, "time": ""}],
        "schedule_enabled": False,
        "output_device_id": "",
    }


def save_config(config: dict) -> None:
    """保存配置文件"""
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


# ==================== 页面路由 ====================

@app.route("/")
def index():
    """主页面"""
    return render_template("index.html")


# ==================== 音频文件 API ====================

@app.route("/api/audio-files", methods=["GET"])
def list_audio_files():
    """获取所有音频文件列表"""
    return jsonify({"success": True, "files": get_audio_files()})


@app.route("/api/audio-files", methods=["POST"])
def upload_audio():
    """上传新音频文件"""
    if "file" not in request.files:
        return jsonify({"success": False, "error": "未选择文件"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"success": False, "error": "文件名为空"}), 400

    if not allowed_file(file.filename):
        return jsonify({"success": False, "error": f"不支持的格式，仅支持: {', '.join(ALLOWED_EXTENSIONS)}"}), 400

    filename = secure_filename(file.filename)
    # 处理重名
    save_path = AUDIO_DIR / filename
    base = Path(filename).stem
    ext = Path(filename).suffix
    counter = 1
    while save_path.exists():
        filename = f"{base}_{counter}{ext}"
        save_path = AUDIO_DIR / filename
        counter += 1

    file.save(str(save_path))
    return jsonify({"success": True, "filename": filename, "message": "上传成功"})


@app.route("/api/audio-files/<path:filename>", methods=["DELETE"])
def delete_audio(filename: str):
    """删除指定音频文件"""
    safe_name = secure_filename(filename)
    file_path = AUDIO_DIR / safe_name
    if not file_path.exists():
        return jsonify({"success": False, "error": "文件不存在"}), 404

    try:
        file_path.unlink()
        return jsonify({"success": True, "message": f"已删除: {safe_name}"})
    except OSError as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/audio-files/<path:filename>", methods=["PUT"])
def rename_audio(filename: str):
    """重命名音频文件"""
    data = request.get_json()
    new_name = data.get("new_name", "").strip()
    if not new_name:
        return jsonify({"success": False, "error": "新文件名不能为空"}), 400

    safe_old = secure_filename(filename)
    safe_new = secure_filename(new_name)

    # 确保扩展名一致
    old_ext = Path(safe_old).suffix
    if not Path(safe_new).suffix:
        safe_new += old_ext

    old_path = AUDIO_DIR / safe_old
    new_path = AUDIO_DIR / safe_new

    if not old_path.exists():
        return jsonify({"success": False, "error": "原文件不存在"}), 404
    if new_path.exists():
        return jsonify({"success": False, "error": "目标文件名已存在"}), 409

    try:
        old_path.rename(new_path)
        return jsonify({"success": True, "new_name": safe_new, "message": "重命名成功"})
    except OSError as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/audio/<path:filename>")
def serve_audio(filename: str):
    """提供音频文件流（用于播放）"""
    safe_name = secure_filename(filename)
    file_path = AUDIO_DIR / safe_name
    if not file_path.exists():
        return jsonify({"error": "文件不存在"}), 404

    mime_type, _ = mimetypes.guess_type(str(file_path))
    return send_file(str(file_path), mimetype=mime_type or "audio/mpeg")


# ==================== 配置 API ====================

@app.route("/api/config", methods=["GET"])
def get_config():
    """获取保存的配置（时间段与音频对应关系）"""
    config = load_config()
    return jsonify({"success": True, "config": config})


@app.route("/api/config", methods=["POST"])
def update_config():
    """保存配置"""
    data = request.get_json()
    if not data or "slots" not in data:
        return jsonify({"success": False, "error": "无效的配置数据"}), 400
    save_config(data)
    return jsonify({"success": True, "message": "配置已保存"})


# ==================== 工具 API ====================

@app.route("/api/open-folder")
def open_folder():
    """在资源管理器中打开音频文件夹"""
    try:
        if os.name == "nt":
            os.startfile(str(AUDIO_DIR))
        else:
            subprocess.Popen(["xdg-open", str(AUDIO_DIR)])
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/check-schedule")
def check_schedule():
    """检查当前时间匹配哪些时间段，返回需要播放的slot列表"""
    now = datetime.now()
    current_time = now.strftime("%H:%M")
    config = load_config()
    matched = []
    for slot in config.get("slots", []):
        slot_time = slot.get("time", "").strip()
        if slot_time and slot_time == current_time and slot.get("audio"):
            matched.append({
                "id": slot["id"],
                "audio": slot["audio"],
                "time": slot_time,
            })
    return jsonify({
        "success": True,
        "current_time": current_time,
        "matched": matched,
        "schedule_enabled": config.get("schedule_enabled", False),
    })


@app.route("/api/multi-upload", methods=["POST"])
def multi_upload():
    """批量上传音频文件"""
    if "files" not in request.files:
        return jsonify({"success": False, "error": "未选择文件"}), 400

    files = request.files.getlist("files")
    uploaded = []
    failed = []

    for file in files:
        if file.filename == "":
            continue
        if not allowed_file(file.filename):
            failed.append({"name": file.filename, "reason": "格式不支持"})
            continue

        filename = secure_filename(file.filename)
        save_path = AUDIO_DIR / filename
        base = Path(filename).stem
        ext = Path(filename).suffix
        counter = 1
        while save_path.exists():
            filename = f"{base}_{counter}{ext}"
            save_path = AUDIO_DIR / filename
            counter += 1

        file.save(str(save_path))
        uploaded.append(filename)

    return jsonify({
        "success": True,
        "uploaded": uploaded,
        "failed": failed,
        "message": f"成功上传 {len(uploaded)} 个文件"
    })


def find_free_port() -> int:
    """找一个可用端口"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_flask(port: int) -> None:
    """在后台线程运行 Flask"""
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    PORT = find_free_port()
    URL = f"http://127.0.0.1:{PORT}"

    print("=" * 50)
    print("  考勤应急语音系统")
    print(f"  音频目录: {AUDIO_DIR}")
    print(f"  音频文件数: {len(get_audio_files())}")
    print(f"  本地地址: {URL}")
    print("=" * 50)

    # 后台启动 Flask
    t = threading.Thread(target=start_flask, args=(PORT,), daemon=True)
    t.start()

    # 创建桌面原生窗口
    webview.create_window(
        title="考勤应急语音系统",
        url=URL,
        width=960,
        height=700,
        resizable=True,
        min_size=(800, 600),
        confirm_close=True,
    )
    webview.start()