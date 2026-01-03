#include "model.hpp"

Model::Model(int batch_size, int channels, int columns, int rows, int move_prior_size)
    : m_batch_size{batch_size},
      m_state_size{columns * rows * channels},
      m_wall_prior_size{2 * columns * rows},
      m_move_prior_size{move_prior_size} {}

int Model::batch_size() const {
    return m_batch_size;
};

int Model::state_size() const {
    return m_state_size;
}

int Model::wall_prior_size() const {
    return m_wall_prior_size;
}

int Model::move_prior_size() const {
    return m_move_prior_size;
}

int Model::prior_size() const {
    return m_wall_prior_size + m_move_prior_size;
}
