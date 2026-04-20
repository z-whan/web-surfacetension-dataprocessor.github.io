import os

from DataProcessor.services.dataframe_loader import read_csv_robust


def csv_to_xlsx(csv_path: str) -> str:
    """Convert CSV to XLSX in the same directory with the same base name."""
    if not os.path.isfile(csv_path):
        raise FileNotFoundError(f"File not found: {csv_path}")

    df = read_csv_robust(csv_path)
    out_path = os.path.splitext(csv_path)[0] + ".xlsx"
    df.to_excel(out_path, index=False)
    return out_path
