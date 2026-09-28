# Lumi sur Hugging Face Spaces (hebergement gratuit sans carte bancaire)
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY . .

# Hugging Face fait tourner le conteneur avec l'utilisateur 1000 :
# on lui donne le dossier des donnees.
RUN mkdir -p /app/data && chown -R 1000:1000 /app

# HF attend l'app sur le port 7860 ; pas de HTTPS auto-signe (HF fournit le vrai)
ENV PORT=7860
ENV NO_HTTPS=1
ENV NO_OPEN_BROWSER=1
EXPOSE 7860

CMD ["npm", "start"]