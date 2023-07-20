# Create venv only if it does not exist.
import subprocess
import venv
import platform
from os import path
from pathlib import Path

def main():
    if Path('venv').exists():
        return

    # Create venv and install dependencies
    print('Creating virtual environment...')
    venv.create('venv', with_pip=True)

    # Use python from venv
    project_root_path = path.join(Path(__file__).parent.parent)
    is_windows = platform.system() == 'Windows'
    interpreter_path = path.join('Scripts','python.exe') if is_windows else path.join('bin','python')
    python_path = path.join(project_root_path, 'venv', interpreter_path)
    requirements_txt_path = path.join(project_root_path, 'requirements.txt')

    # Run pip install
    command = f'{python_path} -m pip install -r {requirements_txt_path}'

    print('Installing dependencies...')
    subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, shell=True)

    print('Dependencies installed!')


if __name__ == '__main__':
    main()
