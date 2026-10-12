import os
import json
import glob
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import make_pipeline
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, classification_report

data_dir = "/home/parshant_01/Desktop/College Project/Data"
files = glob.glob(os.path.join(data_dir, "**/*.json"), recursive=True)

texts = []
labels = []

print(f"Found {len(files)} files. Reading data (this might take a few seconds)...")
for fpath in files:
    try:
        with open(fpath, 'r', encoding='utf-8') as f:
            data = json.load(f)
            heading = data.get('heading', '')
            paras = data.get('paragraphs', [])
            text = heading + " " + " ".join(paras)
            source = data.get('source', 'Unknown')
            
            if text.strip() and source != 'Unknown':
                texts.append(text)
                labels.append(source)
    except Exception as e:
        continue

print(f"Successfully loaded {len(texts)} articles.")

# Train test split
X_train, X_test, y_train, y_test = train_test_split(texts, labels, test_size=0.2, random_state=42)

print("Training the AI model...")
# Create a simple pipeline: TF-IDF -> Naive Bayes
model = make_pipeline(TfidfVectorizer(stop_words='english', max_features=10000), MultinomialNB())
model.fit(X_train, y_train)

print("Testing the AI model...")
predictions = model.predict(X_test)
accuracy = accuracy_score(y_test, predictions)

print(f"\nModel Accuracy: {accuracy * 100:.2f}%\n")
print("Classification Report:")
print(classification_report(y_test, predictions))

# Test with a dummy news
sample_news = "Apple Pay may launch in India next month. The service is expected to support card payments and UPI."
pred = model.predict([sample_news])
print(f"\nTest prediction for sample news: {pred[0]}")
